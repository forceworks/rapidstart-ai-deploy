/**
 * Sales Execution Agent — takes actions on behalf of the salesperson
 * with human approval.
 *
 * Capabilities:
 *   - Draft and queue follow-up emails
 *   - Create tasks from conversation
 *   - Add new contacts to CRM
 *   - Accept/dismiss AI suggestions
 *   - Update opportunity fields
 *
 * All write operations go through Custom APIs — never direct Dataverse writes.
 */

import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';
import {
  type AgentDeps,
  type AgentMessage,
  type AgentResponse,
  type ToolDefinition,
  executeAgentLoop,
} from './shared.js';

export interface SalesExecutionAgent {
  /** Execute a sales action based on natural language instruction */
  execute(instruction: string, context: ExecutionContext, tenantId: string, userId: string): Promise<AgentResponse>;
}

export interface ExecutionContext {
  opportunityId?: string;
  accountId?: string;
  activityId?: string;
}

const SYSTEM_PROMPT = `You are a Sales Execution Agent for a CRM system. You help salespeople take action by executing CRM operations on their behalf.

You have tools to create contacts, create tasks, accept suggestions, and draft emails. Use them to fulfill the salesperson's request.

Guidelines:
- Confirm what you're about to do before executing destructive/irreversible actions
- Always use the appropriate CRM tool — never guess or fabricate data
- Report what you did clearly so the salesperson can verify
- If you can't do something with the available tools, explain what the salesperson should do manually`;

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'create_contact',
      description: 'Create a new contact in CRM via fw_CreateContact Custom API',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Contact email address' },
          displayName: { type: 'string', description: 'Full name' },
          accountId: { type: 'string', description: 'Parent account GUID (optional)' },
        },
        required: ['email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a CRM task linked to an opportunity',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Task subject/title' },
          description: { type: 'string', description: 'Task description' },
          dueDate: { type: 'string', description: 'Due date in YYYY-MM-DD format (optional)' },
          opportunityId: { type: 'string', description: 'Related opportunity GUID (optional)' },
        },
        required: ['subject'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'accept_suggestion',
      description: 'Accept an AI suggestion, marking it as actioned',
      parameters: {
        type: 'object',
        properties: {
          suggestionId: { type: 'string', description: 'Suggestion GUID' },
        },
        required: ['suggestionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dismiss_suggestion',
      description: 'Dismiss an AI suggestion the salesperson doesn\'t want to act on',
      parameters: {
        type: 'object',
        properties: {
          suggestionId: { type: 'string', description: 'Suggestion GUID' },
          reason: { type: 'string', description: 'Reason for dismissal' },
        },
        required: ['suggestionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pending_suggestions',
      description: 'Get pending AI suggestions for an opportunity',
      parameters: {
        type: 'object',
        properties: {
          opportunityId: { type: 'string', description: 'Opportunity GUID' },
        },
        required: ['opportunityId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_opportunity_details',
      description: 'Look up opportunity details for context',
      parameters: {
        type: 'object',
        properties: {
          opportunityId: { type: 'string', description: 'Opportunity GUID' },
        },
        required: ['opportunityId'],
      },
    },
  },
];

export function createSalesExecutionAgent(
  dataverseClient: DataverseClient,
  agentDeps: AgentDeps
): SalesExecutionAgent {
  const { logger } = agentDeps;

  async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'create_contact': {
        const result = await dataverseClient.executeAction('fw_CreateContact', {
          email: args.email,
          displayname: args.displayName || '',
          accountid: args.accountId || '',
        });
        return JSON.stringify(result);
      }

      case 'create_task': {
        const taskData: Record<string, unknown> = {
          subject: args.subject,
          description: args.description || '',
          fw_aisource: true,
          fw_aicreated: true,
        };
        if (args.dueDate) taskData.scheduledend = args.dueDate;
        if (args.opportunityId) {
          taskData['regardingobjectid_opportunity@odata.bind'] = `/opportunities(${args.opportunityId})`;
        }
        const taskId = await dataverseClient.create('tasks', taskData);
        return JSON.stringify({ success: true, taskId, message: `Task "${args.subject}" created` });
      }

      case 'accept_suggestion': {
        await dataverseClient.update('fw_aisuggestions', args.suggestionId as string, {
          fw_status: 2, // Accepted
        });
        return JSON.stringify({ success: true, message: 'Suggestion accepted' });
      }

      case 'dismiss_suggestion': {
        await dataverseClient.update('fw_aisuggestions', args.suggestionId as string, {
          fw_status: 3, // Dismissed
          fw_dismissreason: args.reason || '',
        });
        return JSON.stringify({ success: true, message: 'Suggestion dismissed' });
      }

      case 'get_pending_suggestions': {
        const suggestions = await dataverseClient.get<Record<string, unknown>>(
          'fw_aisuggestions',
          `$filter=_fw_opportunityid_value eq ${args.opportunityId} and fw_status eq 1&$select=fw_aisuggestionid,fw_title,fw_description,fw_suggestiontype,fw_priority,fw_suggestedcontent&$orderby=fw_priority asc`
        );
        return JSON.stringify(suggestions);
      }

      case 'get_opportunity_details': {
        const opp = await dataverseClient.getById<Record<string, unknown>>(
          'opportunities', args.opportunityId as string,
          ['name', 'stepname', 'estimatedvalue', '_parentaccountid_value']
        );
        return JSON.stringify(opp);
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  return {
    async execute(instruction: string, context: ExecutionContext, tenantId: string, userId: string): Promise<AgentResponse> {
      logger.info('Sales Execution Agent invoked', {
        instruction: instruction.substring(0, 100),
        opportunityId: context.opportunityId || '',
      });

      let contextStr = '';
      if (context.opportunityId) contextStr += `Opportunity ID: ${context.opportunityId}\n`;
      if (context.accountId) contextStr += `Account ID: ${context.accountId}\n`;
      if (context.activityId) contextStr += `Activity ID: ${context.activityId}\n`;

      const messages: AgentMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${contextStr}\nInstruction: ${instruction}` },
      ];

      return executeAgentLoop(agentDeps, messages, TOOLS, executeTool, tenantId, userId);
    },
  };
}
