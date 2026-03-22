/**
 * Account Intelligence Agent — answers questions about accounts
 * using Dataverse data as context.
 *
 * Capabilities:
 *   - Look up account details, contacts, and recent activity
 *   - Summarize engagement history and trends
 *   - Identify key stakeholders and gaps
 *   - Provide competitive/risk insights
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

export interface AccountIntelligenceAgent {
  /** Ask a question about an account */
  ask(accountId: string, question: string, tenantId: string, userId: string): Promise<AgentResponse>;
}

const SYSTEM_PROMPT = `You are an Account Intelligence Agent for a CRM system. You help salespeople understand their accounts by analyzing data from Dataverse.

You have tools to look up account details, contacts, recent meetings, engagement scores, and risk signals. Use them to provide data-driven answers.

Guidelines:
- Always ground your answers in actual data from the tools
- Highlight actionable insights (e.g., "You should reach out to...")
- Flag risks and opportunities
- Be concise but thorough
- If data is missing, say so rather than guessing`;

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_account_details',
      description: 'Get account information including name, industry, revenue, and AI engagement metrics',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: 'Account GUID' },
        },
        required: ['accountId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_account_contacts',
      description: 'Get all contacts associated with an account',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: 'Account GUID' },
        },
        required: ['accountId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_account_opportunities',
      description: 'Get open opportunities for an account with stage, value, and risk status',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: 'Account GUID' },
        },
        required: ['accountId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_meetings',
      description: 'Get recent AI-captured meetings for an account (last 30 days)',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: 'Account GUID' },
          days: { type: 'number', description: 'Number of days to look back (default 30)' },
        },
        required: ['accountId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stakeholder_alerts',
      description: 'Get open stakeholder alerts (unknown participants) for an account',
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

export function createAccountIntelligenceAgent(
  dataverseClient: DataverseClient,
  agentDeps: AgentDeps
): AccountIntelligenceAgent {
  const { logger } = agentDeps;

  async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const accountId = args.accountId as string;

    switch (name) {
      case 'get_account_details': {
        const account = await dataverseClient.getById<Record<string, unknown>>(
          'accounts', accountId,
          ['name', 'industrycode', 'revenue', 'numberofemployees', 'websiteurl',
           'emailaddress1', 'telephone1', 'fw_engagementscore', 'fw_engagementtrend',
           'fw_lastsignaldate', 'fw_signalcount']
        );
        return JSON.stringify(account);
      }

      case 'get_account_contacts': {
        const contacts = await dataverseClient.get<Record<string, unknown>>(
          'contacts',
          `$filter=_parentcustomerid_value eq ${accountId}&$select=contactid,fullname,emailaddress1,jobtitle,telephone1,fw_aisource&$orderby=fullname`
        );
        return JSON.stringify(contacts);
      }

      case 'get_account_opportunities': {
        const opps = await dataverseClient.get<Record<string, unknown>>(
          'opportunities',
          `$filter=_parentaccountid_value eq ${accountId} and statecode eq 0&$select=opportunityid,name,stepname,estimatedvalue,estimatedclosedate,fw_atrisk,fw_risklevel,fw_riskreason,fw_engagementscore,fw_engagementtrend&$orderby=estimatedvalue desc`
        );
        return JSON.stringify(opps);
      }

      case 'get_recent_meetings': {
        const days = (args.days as number) || 30;
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const meetings = await dataverseClient.get<Record<string, unknown>>(
          'appointments',
          `$filter=_regardingobjectid_value eq ${accountId} and fw_aisource eq true and scheduledstart ge ${cutoff}&$select=activityid,subject,scheduledstart,fw_aisummary,fw_sentiment,fw_confidencescore&$orderby=scheduledstart desc&$top=20`
        );
        return JSON.stringify(meetings);
      }

      case 'get_stakeholder_alerts': {
        const alerts = await dataverseClient.get<Record<string, unknown>>(
          'fw_stakeholderalerts',
          `$filter=_fw_accountid_value eq ${accountId} and fw_status eq 1&$select=fw_message,fw_alerttype,fw_stakeholderemails,fw_stakeholdercount&$orderby=createdon desc`
        );
        return JSON.stringify(alerts);
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  return {
    async ask(accountId: string, question: string, tenantId: string, userId: string): Promise<AgentResponse> {
      logger.info('Account Intelligence Agent invoked', { accountId, question: question.substring(0, 100) });

      const messages: AgentMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Account ID: ${accountId}\n\nQuestion: ${question}` },
      ];

      return executeAgentLoop(agentDeps, messages, TOOLS, executeTool, tenantId, userId);
    },
  };
}
