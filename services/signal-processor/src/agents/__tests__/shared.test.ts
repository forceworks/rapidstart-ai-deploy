import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeAgentLoop, type AgentDeps, type AgentMessage, type ToolDefinition } from '../shared.js';

function createMockDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    config: {
      endpoint: 'https://test.openai.azure.com',
      deployment: 'gpt-4o',
      apiKey: 'test-key',
      keySource: 'environment' as const,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trackSignal: vi.fn(),
      trackDependency: vi.fn(),
    },
    tokenProvider: { getToken: vi.fn().mockResolvedValue('token') },
    usageGovernance: {
      checkUsage: vi.fn().mockResolvedValue({ allowed: true }),
      recordUsage: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as unknown as AgentDeps;
}

describe('executeAgentLoop', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns usage-blocked response when governance denies', async () => {
    const deps = createMockDeps({
      usageGovernance: {
        checkUsage: vi.fn().mockResolvedValue({ allowed: false, reason: 'Limit reached' }),
        recordUsage: vi.fn(),
      } as any,
    });

    const messages: AgentMessage[] = [
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: 'Hello' },
    ];

    const result = await executeAgentLoop(deps, messages, [], vi.fn(), 'tenant-1', 'user-1');

    expect(result.success).toBe(false);
    expect(result.message).toBe('Limit reached');
    expect(result.tokensUsed).toBe(0);
  });

  it('returns final answer when no tool calls', async () => {
    const deps = createMockDeps();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'Here is your answer.', tool_calls: undefined }, finish_reason: 'stop' }],
        usage: { total_tokens: 150 },
      }),
    } as Response);

    const messages: AgentMessage[] = [
      { role: 'system', content: 'Test.' },
      { role: 'user', content: 'Question?' },
    ];

    const result = await executeAgentLoop(deps, messages, [], vi.fn(), 'tenant-1', 'user-1');

    expect(result.success).toBe(true);
    expect(result.message).toBe('Here is your answer.');
    expect(result.tokensUsed).toBe(150);
    expect(result.toolCallsExecuted).toBe(0);
  });

  it('executes tool calls and returns final response', async () => {
    const deps = createMockDeps();
    const toolExecutor = vi.fn().mockResolvedValue(JSON.stringify({ name: 'Contoso' }));

    // First call: model requests a tool call
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: { name: 'get_account', arguments: '{"accountId":"acc-1"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { total_tokens: 100 },
        }),
      } as Response)
      // Second call: model returns final answer
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'The account is Contoso.' }, finish_reason: 'stop' }],
          usage: { total_tokens: 80 },
        }),
      } as Response);

    const tools: ToolDefinition[] = [{
      type: 'function',
      function: { name: 'get_account', description: 'Get account', parameters: { type: 'object', properties: {} } },
    }];

    const messages: AgentMessage[] = [
      { role: 'system', content: 'Test.' },
      { role: 'user', content: 'Tell me about acc-1' },
    ];

    const result = await executeAgentLoop(deps, messages, tools, toolExecutor, 'tenant-1', 'user-1');

    expect(result.success).toBe(true);
    expect(result.message).toBe('The account is Contoso.');
    expect(result.toolCallsExecuted).toBe(1);
    expect(result.tokensUsed).toBe(180);
    expect(toolExecutor).toHaveBeenCalledWith('get_account', { accountId: 'acc-1' });
  });

  it('handles OpenAI API error', async () => {
    const deps = createMockDeps();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    } as Response);

    const messages: AgentMessage[] = [
      { role: 'system', content: 'Test.' },
      { role: 'user', content: 'Hello' },
    ];

    const result = await executeAgentLoop(deps, messages, [], vi.fn(), 'tenant-1', 'user-1');

    expect(result.success).toBe(false);
    expect(result.message).toContain('429');
  });

  it('handles tool execution failure gracefully', async () => {
    const deps = createMockDeps();
    const toolExecutor = vi.fn().mockRejectedValue(new Error('Dataverse timeout'));

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: { name: 'get_data', arguments: '{}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { total_tokens: 50 },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Sorry, I had trouble fetching data.' }, finish_reason: 'stop' }],
          usage: { total_tokens: 60 },
        }),
      } as Response);

    const messages: AgentMessage[] = [
      { role: 'system', content: 'Test.' },
      { role: 'user', content: 'Get data' },
    ];

    const result = await executeAgentLoop(deps, messages, [], toolExecutor, 'tenant-1', 'user-1');

    expect(result.success).toBe(true);
    expect(result.toolCallsExecuted).toBe(1);
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});
