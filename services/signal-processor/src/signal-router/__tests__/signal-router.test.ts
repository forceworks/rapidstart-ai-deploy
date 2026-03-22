import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

// Use vi.hoisted() so these are available inside vi.mock factories (which are hoisted)
const { mockGet, mockCreate, mockUpdate, mockSendSignal } = vi.hoisted(() => ({
  mockGet: vi.fn().mockResolvedValue([]),
  mockCreate: vi.fn().mockResolvedValue('id'),
  mockUpdate: vi.fn(),
  mockSendSignal: vi.fn().mockResolvedValue(undefined),
}));

// Mock all dependencies
vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    dataverse: { url: 'https://test.crm.dynamics.com', toolBaseUrl: 'https://test.crm.dynamics.com/api/data/v9.2' },
    credentials: { source: 'client-credentials', tenantId: 't', clientId: 'c', clientSecret: 's' },
    openai: { endpoint: 'https://test.openai.azure.com', deployment: 'gpt-4o', keySource: 'environment' },
    serviceBus: { connectionString: 'conn', signalQueueName: 'signals', deadLetterQueueName: 'dlq' },
    governance: { licenseTier: 'pro', monthlyCapPerUser: 0 },
    logging: { appInsightsConnectionString: '', logLevel: 'info' },
  }),
}));

vi.mock('../../shared/credentials.js', () => ({
  createTokenProvider: vi.fn().mockReturnValue({ getToken: vi.fn().mockResolvedValue('token') }),
  getDataverseToken: vi.fn().mockResolvedValue('token'),
  getGraphToken: vi.fn().mockResolvedValue('token'),
}));

vi.mock('../../shared/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), trackSignal: vi.fn(), trackDependency: vi.fn(),
  }),
}));

vi.mock('../../shared/dataverse-client.js', () => ({
  createDataverseClient: vi.fn().mockReturnValue({
    get: mockGet, getById: vi.fn(), executeAction: vi.fn(), create: mockCreate, update: mockUpdate,
  }),
}));

vi.mock('../../shared/queue-client.js', () => ({
  createQueueClient: vi.fn().mockReturnValue({
    sendSignal: mockSendSignal, sendToDeadLetter: vi.fn(), close: vi.fn(),
  }),
}));

vi.mock('../../shared/usage-governance.js', () => ({
  createUsageGovernanceService: vi.fn().mockReturnValue({
    checkUsage: vi.fn().mockResolvedValue({ allowed: true, currentCount: 0, limit: 1000, licenseTier: 'pro' }),
    recordUsage: vi.fn(),
  }),
}));

// Mock graph-fetcher
vi.mock('../graph-fetcher.js', () => ({
  createGraphEventFetcher: vi.fn().mockReturnValue({
    getCalendarEvent: vi.fn().mockResolvedValue({
      id: 'signal-uuid',
      graphResourceId: 'event-1',
      signalType: 'meeting',
      tenantId: '',
      userId: 'user-1',
      userEmail: 'user@test.com',
      subject: 'Test Meeting',
      startTime: '2026-01-01T10:00:00Z',
      participants: [{ email: 'ext@company.com' }],
      rawPayload: {},
      receivedAt: '2026-01-01T09:55:00Z',
    }),
  }),
}));

// Import after mocks are set up
import { signalRouterHandler } from '../index.js';

function createMockRequest(options: {
  query?: Record<string, string>;
  body?: unknown;
}): HttpRequest {
  return {
    query: new URLSearchParams(options.query || {}),
    json: vi.fn().mockResolvedValue(options.body),
  } as unknown as HttpRequest;
}

const mockContext = {} as InvocationContext;

describe('signalRouterHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns validationToken on Graph validation request', async () => {
    const request = createMockRequest({ query: { validationToken: 'test-token-123' } });

    const response = await signalRouterHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect(response.body).toBe('test-token-123');
  });

  it('returns 400 on invalid JSON body', async () => {
    const request = {
      query: new URLSearchParams(),
      json: vi.fn().mockRejectedValue(new Error('parse error')),
    } as unknown as HttpRequest;

    const response = await signalRouterHandler(request, mockContext);

    expect(response.status).toBe(400);
  });

  it('returns 400 on invalid notification format', async () => {
    const request = createMockRequest({ body: { invalid: true } });

    const response = await signalRouterHandler(request, mockContext);

    expect(response.status).toBe(400);
  });

  it('returns 202 with dispatched status on valid notification', async () => {
    const request = createMockRequest({
      body: {
        value: [{
          subscriptionId: 'sub-1',
          changeType: 'created',
          resource: 'users/user-1/events/event-1',
          resourceData: { id: 'event-1', '@odata.type': '#Microsoft.Graph.Event' },
          tenantId: 'tenant-1',
        }],
      },
    });

    const response = await signalRouterHandler(request, mockContext);

    expect(response.status).toBe(202);
    const body = response.jsonBody as { processed: number; results: Array<{ status: string }> };
    expect(body.processed).toBe(1);
    expect(body.results[0].status).toBe('dispatched');
  });

  it('skips duplicate signals (idempotency)', async () => {
    // Signal already exists in log
    mockGet.mockResolvedValueOnce([{ fw_signallogid: 'existing' }]);

    const request = createMockRequest({
      body: {
        value: [{
          subscriptionId: 'sub-1',
          changeType: 'created',
          resource: 'users/user-1/events/event-1',
          resourceData: { id: 'event-1', '@odata.type': '' },
          tenantId: 'tenant-1',
        }],
      },
    });

    const response = await signalRouterHandler(request, mockContext);

    expect(response.status).toBe(202);
    const body = response.jsonBody as { results: Array<{ status: string }> };
    expect(body.results[0].status).toBe('skipped-duplicate');
    expect(mockSendSignal).not.toHaveBeenCalled();
  });

  it('returns 202 with no actionable notifications when all are deleted', async () => {
    const request = createMockRequest({
      body: {
        value: [{
          subscriptionId: 'sub-1',
          changeType: 'deleted',
          resource: 'users/user-1/events/event-1',
          resourceData: { id: 'event-1', '@odata.type': '' },
          tenantId: 'tenant-1',
        }],
      },
    });

    const response = await signalRouterHandler(request, mockContext);

    expect(response.status).toBe(202);
    expect(response.body).toBe('No actionable notifications');
  });
});
