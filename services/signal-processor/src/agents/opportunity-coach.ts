/**
 * Opportunity Coach Agent — provides coaching and strategic advice
 * for specific opportunities.
 *
 * Capabilities:
 *   - Analyze opportunity health and risk factors
 *   - Suggest next steps based on stage and engagement
 *   - Review meeting history and sentiment trends
 *   - Recommend stakeholder engagement strategies
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

export interface OpportunityCoachAgent {
  /** Ask for coaching on an opportunity */
  coach(opportunityId: string, question: string, tenantId: string, userId: string): Promise<AgentResponse>;
}

const SYSTEM_PROMPT = `You are an Opportunity Coach Agent for a CRM system. You help salespeople win deals by analyzing opportunity data and providing strategic coaching.

You have tools to look up opportunity details, risk assessments, meeting history, engagement metrics, and AI suggestions. Use them to provide actionable coaching.

Guidelines:
- Focus on what the salesperson should DO, not just what's happening
- Reference specific data points to support your recommendations
- Consider the sales stage when giving advice
- Highlight risks early and suggest mitigation strategies
- Be direct and actionable — salespeople are busy`;

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_opportunity_details',
      description: 'Get opportunity details including stage, value, risk status, and engagement metrics',
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
      name: 'get_opportunity_meetings',
      description: 'Get recent meetings related to this opportunity',
      parameters: {
        type: 'object',
        properties: {
          opportunityId: { type: 'string', description: 'Opportunity GUID' },
          limit: { type: 'number', description: 'Max meetings to return (default 10)' },
        },
        required: ['opportunityId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_opportunity_suggestions',
      description: 'Get AI-generated suggestions for this opportunity',
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
      name: 'get_opportunity_tasks',
      description: 'Get open tasks related to this opportunity',
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
      name: 'get_account_contacts',
      description: 'Get contacts for the parent account of this opportunity',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: 'Account GUID' },
        },
        required: ['accountId'],
      },
    },
  },
];

export function createOpportunityCoachAgent(
  dataverseClient: DataverseClient,
  agentDeps: AgentDeps
): OpportunityCoachAgent {
  const { logger } = agentDeps;

  async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'get_opportunity_details': {
        const opp = await dataverseClient.getById<Record<string, unknown>>(
          'opportunities', args.opportunityId as string,
          ['name', 'stepname', 'salesstagecode', 'estimatedvalue', 'estimatedclosedate',
           'statecode', 'fw_atrisk', 'fw_risklevel', 'fw_riskreason', 'fw_riskfactors',
           'fw_engagementscore', 'fw_engagementtrend', 'fw_lastsignaldate', 'fw_signalcount',
           '_parentaccountid_value', 'description']
        );
        return JSON.stringify(opp);
      }

      case 'get_opportunity_meetings': {
        const limit = (args.limit as number) || 10;
        const meetings = await dataverseClient.get<Record<string, unknown>>(
          'appointments',
          `$filter=_regardingobjectid_value eq ${args.opportunityId} and fw_aisource eq true&$select=activityid,subject,scheduledstart,fw_aisummary,fw_sentiment,fw_keydecisions,fw_actionitems,fw_nextsteps&$orderby=scheduledstart desc&$top=${limit}`
        );
        return JSON.stringify(meetings);
      }

      case 'get_opportunity_suggestions': {
        const suggestions = await dataverseClient.get<Record<string, unknown>>(
          'fw_aisuggestions',
          `$filter=_fw_opportunityid_value eq ${args.opportunityId} and fw_status eq 1&$select=fw_title,fw_description,fw_suggestiontype,fw_priority,fw_suggestedcontent,fw_actiondata&$orderby=fw_priority asc`
        );
        return JSON.stringify(suggestions);
      }

      case 'get_opportunity_tasks': {
        const tasks = await dataverseClient.get<Record<string, unknown>>(
          'tasks',
          `$filter=_regardingobjectid_value eq ${args.opportunityId} and statecode eq 0&$select=subject,description,scheduledend,prioritycode,fw_aisource&$orderby=scheduledend asc`
        );
        return JSON.stringify(tasks);
      }

      case 'get_account_contacts': {
        const contacts = await dataverseClient.get<Record<string, unknown>>(
          'contacts',
          `$filter=_parentcustomerid_value eq ${args.accountId}&$select=fullname,emailaddress1,jobtitle&$orderby=fullname`
        );
        return JSON.stringify(contacts);
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  return {
    async coach(opportunityId: string, question: string, tenantId: string, userId: string): Promise<AgentResponse> {
      logger.info('Opportunity Coach Agent invoked', { opportunityId, question: question.substring(0, 100) });

      const messages: AgentMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Opportunity ID: ${opportunityId}\n\nQuestion: ${question}` },
      ];

      return executeAgentLoop(agentDeps, messages, TOOLS, executeTool, tenantId, userId);
    },
  };
}
