/**
 * Shared agent infrastructure — tool definitions, conversation management,
 * and OpenAI chat completion helpers for all AI agents.
 *
 * Each agent is a function that:
 *   1. Receives a user message + conversation history
 *   2. Calls Azure OpenAI with agent-specific tools
 *   3. Executes tool calls against Dataverse
 *   4. Returns the final response
 */

import { type AppConfig } from '../shared/config.js';
import { type Logger } from '../shared/logger.js';
import { type TokenProvider } from '../shared/credentials.js';
import { type UsageGovernanceService } from '../shared/usage-governance.js';

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentResponse {
  success: boolean;
  message: string;
  toolCallsExecuted: number;
  tokensUsed: number;
  errorMessage?: string;
}

export interface AgentDeps {
  config: AppConfig['openai'];
  logger: Logger;
  tokenProvider: TokenProvider;
  usageGovernance: UsageGovernanceService;
}

/** Maximum tool-call rounds to prevent infinite loops */
const MAX_TOOL_ROUNDS = 5;

/**
 * Execute an agent conversation loop with tool calling.
 * Handles the OpenAI → tool execution → OpenAI cycle.
 */
export async function executeAgentLoop(
  deps: AgentDeps,
  messages: AgentMessage[],
  tools: ToolDefinition[],
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>,
  tenantId: string,
  userId: string
): Promise<AgentResponse> {
  const { config, logger, usageGovernance } = deps;
  let totalTokens = 0;
  let toolCallsExecuted = 0;

  // Pre-spend governance
  const usageCheck = await usageGovernance.checkUsage(tenantId, userId);
  if (!usageCheck.allowed) {
    return {
      success: false,
      message: usageCheck.reason || 'Usage limit reached',
      toolCallsExecuted: 0,
      tokensUsed: 0,
      errorMessage: usageCheck.reason,
    };
  }

  const apiUrl = `${config.endpoint.replace(/\/$/, '')}/openai/deployments/${config.deployment}/chat/completions?api-version=2024-08-01-preview`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.keySource === 'environment' && config.apiKey) {
    headers['api-key'] = config.apiKey;
  } else {
    const token = await deps.tokenProvider.getToken(['https://cognitiveservices.azure.com/.default']);
    headers['Authorization'] = `Bearer ${token}`;
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: 0.3,
        max_tokens: 3000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        message: `OpenAI error: ${response.status}`,
        toolCallsExecuted,
        tokensUsed: totalTokens,
        errorMessage: errorText,
      };
    }

    const result = (await response.json()) as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: ToolCall[];
        };
        finish_reason: string;
      }>;
      usage: { total_tokens: number };
    };

    totalTokens += result.usage?.total_tokens || 0;
    const choice = result.choices[0];

    if (!choice) {
      return {
        success: false,
        message: 'No response from OpenAI',
        toolCallsExecuted,
        tokensUsed: totalTokens,
      };
    }

    // If no tool calls, we have the final answer
    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      await usageGovernance.recordUsage(tenantId, userId);
      return {
        success: true,
        message: choice.message.content || '',
        toolCallsExecuted,
        tokensUsed: totalTokens,
      };
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: choice.message.content || '',
      tool_calls: choice.message.tool_calls,
    });

    // Execute each tool call
    for (const toolCall of choice.message.tool_calls) {
      toolCallsExecuted++;
      let toolResult: string;

      try {
        const args = JSON.parse(toolCall.function.arguments);
        toolResult = await toolExecutor(toolCall.function.name, args);
      } catch (error) {
        toolResult = JSON.stringify({ error: String(error) });
        logger.warn('Agent tool call failed', {
          tool: toolCall.function.name,
          error: String(error),
        });
      }

      messages.push({
        role: 'tool',
        content: toolResult,
        tool_call_id: toolCall.id,
      });
    }
  }

  // Exhausted rounds
  await usageGovernance.recordUsage(tenantId, userId);
  return {
    success: true,
    message: 'I was unable to fully complete the request within the allowed number of steps. Here is what I found so far.',
    toolCallsExecuted,
    tokensUsed: totalTokens,
  };
}
