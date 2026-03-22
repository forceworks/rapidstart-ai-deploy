import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAISummarizer, parseSummaryResponse, buildUserPrompt, extractBody } from '../index.js';
import { type Logger } from '../../shared/logger.js';
import { type TokenProvider } from '../../shared/credentials.js';
import { type UsageGovernanceService } from '../../shared/usage-governance.js';
import { type Signal, type MeetingSummary } from '../../shared/types.js';
import { type AppConfig } from '../../shared/config.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trackSignal: vi.fn(),
    trackDependency: vi.fn(),
  };
}

const testSignal: Signal = {
  id: 'signal-1',
  graphResourceId: 'graph-1',
  signalType: 'meeting',
  tenantId: 'tenant-1',
  userId: 'user-1',
  userEmail: 'user@test.com',
  subject: 'Q4 Pipeline Review',
  startTime: '2026-01-15T10:00:00Z',
  endTime: '2026-01-15T11:00:00Z',
  participants: [
    { email: 'jane@partner.com', displayName: 'Jane Smith' },
    { email: 'bob@partner.com', displayName: 'Bob Jones' },
  ],
  rawPayload: {
    body: {
      content: '<p>Discuss Q4 pipeline numbers</p>',
      contentType: 'html',
    },
  },
  receivedAt: '2026-01-15T09:55:00Z',
};

const validSummaryJson = JSON.stringify({
  summary: 'The team discussed Q4 pipeline numbers. Revenue is on track.',
  keyDecisions: ['Proceed with expansion plan', 'Delay hiring until Q1'],
  actionItems: [
    { description: 'Send updated forecast', assignee: 'jane@partner.com', dueDate: '2026-01-20' },
    { description: 'Review contract terms', assignee: 'Bob Jones' },
  ],
  nextSteps: ['Follow-up meeting next week', 'Share deck with stakeholders'],
  sentiment: 'positive',
  topics: ['pipeline', 'revenue', 'hiring'],
});

describe('parseSummaryResponse', () => {
  it('parses valid JSON response', () => {
    const result = parseSummaryResponse(validSummaryJson);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('The team discussed Q4 pipeline numbers. Revenue is on track.');
    expect(result!.keyDecisions).toHaveLength(2);
    expect(result!.actionItems).toHaveLength(2);
    expect(result!.actionItems[0].assignee).toBe('jane@partner.com');
    expect(result!.nextSteps).toHaveLength(2);
    expect(result!.sentiment).toBe('positive');
    expect(result!.topics).toHaveLength(3);
  });

  it('handles JSON wrapped in markdown code fences', () => {
    const wrapped = '```json\n' + validSummaryJson + '\n```';
    const result = parseSummaryResponse(wrapped);
    expect(result).not.toBeNull();
    expect(result!.summary).toContain('Q4 pipeline');
  });

  it('returns null for empty summary', () => {
    const result = parseSummaryResponse(JSON.stringify({ summary: '', sentiment: 'neutral' }));
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseSummaryResponse('not json')).toBeNull();
  });

  it('defaults sentiment to neutral if invalid', () => {
    const result = parseSummaryResponse(
      JSON.stringify({ summary: 'A meeting', sentiment: 'excited', keyDecisions: [] })
    );
    expect(result).not.toBeNull();
    expect(result!.sentiment).toBe('neutral');
  });

  it('filters non-string values from arrays', () => {
    const result = parseSummaryResponse(
      JSON.stringify({
        summary: 'Test',
        keyDecisions: ['valid', 123, null, 'also valid'],
        actionItems: [
          { description: 'good' },
          { description: '' }, // empty description filtered
          null, // non-object filtered
        ],
        nextSteps: [],
        sentiment: 'neutral',
        topics: ['a', 42, 'b'],
      })
    );
    expect(result).not.toBeNull();
    expect(result!.keyDecisions).toEqual(['valid', 'also valid']);
    expect(result!.actionItems).toHaveLength(1);
    expect(result!.topics).toEqual(['a', 'b']);
  });

  it('handles missing arrays gracefully', () => {
    const result = parseSummaryResponse(JSON.stringify({ summary: 'Minimal meeting', sentiment: 'neutral' }));
    expect(result).not.toBeNull();
    expect(result!.keyDecisions).toEqual([]);
    expect(result!.actionItems).toEqual([]);
    expect(result!.nextSteps).toEqual([]);
    expect(result!.topics).toEqual([]);
  });
});

describe('extractBody', () => {
  it('strips HTML tags from HTML content', () => {
    const result = extractBody({
      body: { content: '<p>Hello <b>world</b></p>', contentType: 'html' },
    });
    expect(result).toBe('Hello world');
  });

  it('returns plain text as-is', () => {
    const result = extractBody({
      body: { content: 'Plain text content', contentType: 'text' },
    });
    expect(result).toBe('Plain text content');
  });

  it('returns null when no body', () => {
    expect(extractBody({})).toBeNull();
    expect(extractBody({ body: {} })).toBeNull();
    expect(extractBody({ body: { content: '' } })).toBeNull();
  });

  it('decodes HTML entities', () => {
    const result = extractBody({
      body: { content: '5 &gt; 3 &amp; 2 &lt; 4', contentType: 'html' },
    });
    expect(result).toBe('5 > 3 & 2 < 4');
  });
});

describe('buildUserPrompt', () => {
  it('includes subject, time, and participants', () => {
    const prompt = buildUserPrompt(testSignal);
    expect(prompt).toContain('Q4 Pipeline Review');
    expect(prompt).toContain('2026-01-15T10:00:00Z');
    expect(prompt).toContain('Jane Smith <jane@partner.com>');
    expect(prompt).toContain('Bob Jones <bob@partner.com>');
    expect(prompt).toContain('user@test.com');
  });

  it('includes body from raw payload', () => {
    const prompt = buildUserPrompt(testSignal);
    expect(prompt).toContain('Discuss Q4 pipeline numbers');
  });

  it('includes transcript when provided', () => {
    const prompt = buildUserPrompt(testSignal, 'Speaker 1: Hello everyone');
    expect(prompt).toContain('Transcript:');
    expect(prompt).toContain('Speaker 1: Hello everyone');
  });
});

describe('createAISummarizer', () => {
  let mockLogger: Logger;
  let mockTokenProvider: TokenProvider;
  let mockUsageGovernance: UsageGovernanceService;
  let mockConfig: AppConfig['openai'];

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockTokenProvider = {
      getToken: vi.fn().mockResolvedValue('mock-token'),
    };
    mockUsageGovernance = {
      checkUsage: vi.fn().mockResolvedValue({ allowed: true, currentCount: 5, limit: 1000, licenseTier: 'pro' }),
      recordUsage: vi.fn().mockResolvedValue(undefined),
    };
    mockConfig = {
      endpoint: 'https://test.openai.azure.com/',
      apiKey: 'test-key',
      deployment: 'gpt-4o',
      keySource: 'environment',
    };
  });

  it('returns failure when usage limit is reached', async () => {
    (mockUsageGovernance.checkUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      currentCount: 1000,
      limit: 1000,
      licenseTier: 'pro',
      reason: 'Monthly limit reached',
    });

    const summarizer = createAISummarizer({
      config: mockConfig,
      logger: mockLogger,
      tokenProvider: mockTokenProvider,
      usageGovernance: mockUsageGovernance,
    });

    const result = await summarizer.summarize(testSignal);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('limit');
    expect(result.tokensUsed).toBe(0);
  });

  it('returns failure gracefully on fetch error (never throws)', async () => {
    // Mock fetch to fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const summarizer = createAISummarizer({
      config: mockConfig,
      logger: mockLogger,
      tokenProvider: mockTokenProvider,
      usageGovernance: mockUsageGovernance,
    });

    const result = await summarizer.summarize(testSignal);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Network error');

    globalThis.fetch = originalFetch;
  });

  it('calls OpenAI with correct endpoint and records usage on success', async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn();

    // First call: transcript fetch (no online meeting)
    // Second call: OpenAI completion
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: validSummaryJson } }],
        usage: { total_tokens: 450 },
      }),
    });

    globalThis.fetch = mockFetch;

    const summarizer = createAISummarizer({
      config: mockConfig,
      logger: mockLogger,
      tokenProvider: mockTokenProvider,
      usageGovernance: mockUsageGovernance,
    });

    const result = await summarizer.summarize(testSignal);
    expect(result.success).toBe(true);
    expect(result.meetingSummary).not.toBeNull();
    expect(result.meetingSummary!.summary).toContain('Q4 pipeline');
    expect(result.tokensUsed).toBe(450);

    // Verify usage was recorded
    expect(mockUsageGovernance.recordUsage).toHaveBeenCalledWith('tenant-1', 'user-1');

    // Verify OpenAI was called with correct URL
    const openAiCall = mockFetch.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('openai/deployments/gpt-4o')
    );
    expect(openAiCall).toBeDefined();
    expect((openAiCall![0] as string)).toContain('test.openai.azure.com');

    globalThis.fetch = originalFetch;
  });

  it('returns failure when OpenAI returns invalid JSON', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'not valid json at all' } }],
        usage: { total_tokens: 100 },
      }),
    });

    const summarizer = createAISummarizer({
      config: mockConfig,
      logger: mockLogger,
      tokenProvider: mockTokenProvider,
      usageGovernance: mockUsageGovernance,
    });

    const result = await summarizer.summarize(testSignal);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('parse');

    // Usage should NOT be recorded on failure
    expect(mockUsageGovernance.recordUsage).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });
});
