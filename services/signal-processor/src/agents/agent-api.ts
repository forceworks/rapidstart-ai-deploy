/**
 * HTTP endpoints for AI Agents — exposes agent capabilities to the
 * Salesperson Cockpit SPA and Teams app.
 *
 * All endpoints require Azure AD bearer token. Tenant/user extracted from token claims.
 */

import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { initializeServices } from '../signal-processor/container.js';
import { createAccountIntelligenceAgent } from './account-intelligence.js';
import { createOpportunityCoachAgent } from './opportunity-coach.js';
import { createSalesExecutionAgent } from './sales-execution.js';
import { type AgentDeps } from './shared.js';

let agentDeps: AgentDeps | undefined;

function getAgentDeps(): AgentDeps {
  if (!agentDeps) {
    const services = initializeServices();
    agentDeps = {
      config: require('../shared/config.js').loadConfig().openai,
      logger: services.logger,
      tokenProvider: require('../shared/credentials.js').createTokenProvider(
        require('../shared/config.js').loadConfig().credentials
      ),
      usageGovernance: services.usageGovernance,
    };
  }
  return agentDeps;
}

interface TokenClaims {
  tenantId: string;
  userId: string;
}

function extractClaims(req: HttpRequest): TokenClaims | null {
  // Azure Functions EasyAuth populates these headers
  const tenantId = req.headers.get('x-ms-token-aad-tenant-id')
    || req.headers.get('x-ms-client-principal-id-provider-tenant');
  const userId = req.headers.get('x-ms-token-aad-object-id')
    || req.headers.get('x-ms-client-principal-id');

  if (!tenantId || !userId) return null;
  return { tenantId, userId };
}

function unauthorized(): HttpResponseInit {
  return { status: 401, jsonBody: { error: 'Unauthorized — missing identity claims' } };
}

// ── Account Intelligence ──────────────────────────────────────────────────────

app.http('agent-account-intelligence', {
  methods: ['POST'],
  authLevel: 'anonymous', // rely on EasyAuth / Azure AD
  route: 'agents/account-intelligence',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const claims = extractClaims(req);
    if (!claims) return unauthorized();

    const body = (await req.json()) as { accountId: string; question: string };
    if (!body.accountId || !body.question) {
      return { status: 400, jsonBody: { error: 'accountId and question are required' } };
    }

    const deps = getAgentDeps();
    const services = initializeServices();
    const agent = createAccountIntelligenceAgent(services.dataverseClient, deps);
    const result = await agent.ask(body.accountId, body.question, claims.tenantId, claims.userId);

    return { status: result.success ? 200 : 500, jsonBody: result };
  },
});

// ── Opportunity Coach ─────────────────────────────────────────────────────────

app.http('agent-opportunity-coach', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agents/opportunity-coach',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const claims = extractClaims(req);
    if (!claims) return unauthorized();

    const body = (await req.json()) as { opportunityId: string; question: string };
    if (!body.opportunityId || !body.question) {
      return { status: 400, jsonBody: { error: 'opportunityId and question are required' } };
    }

    const deps = getAgentDeps();
    const services = initializeServices();
    const agent = createOpportunityCoachAgent(services.dataverseClient, deps);
    const result = await agent.coach(body.opportunityId, body.question, claims.tenantId, claims.userId);

    return { status: result.success ? 200 : 500, jsonBody: result };
  },
});

// ── Sales Execution ───────────────────────────────────────────────────────────

app.http('agent-sales-execution', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agents/sales-execution',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const claims = extractClaims(req);
    if (!claims) return unauthorized();

    const body = (await req.json()) as {
      instruction: string;
      context?: { opportunityId?: string; accountId?: string; activityId?: string };
    };
    if (!body.instruction) {
      return { status: 400, jsonBody: { error: 'instruction is required' } };
    }

    const deps = getAgentDeps();
    const services = initializeServices();
    const agent = createSalesExecutionAgent(services.dataverseClient, deps);
    const result = await agent.execute(
      body.instruction,
      body.context || {},
      claims.tenantId,
      claims.userId
    );

    return { status: result.success ? 200 : 500, jsonBody: result };
  },
});
