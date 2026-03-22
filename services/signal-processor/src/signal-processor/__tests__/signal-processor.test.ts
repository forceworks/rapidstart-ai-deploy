import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InvocationContext } from '@azure/functions';

// Use vi.hoisted() for mocks referenced inside vi.mock factories
const {
  mockMatchEntities,
  mockScore,
  mockLogMeeting,
  mockEnqueue,
  mockUpdateStatus,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockMatchEntities: vi.fn().mockResolvedValue([]),
  mockScore: vi.fn().mockReturnValue({
    overallConfidence: 0,
    accountMatch: null,
    contactMatches: [],
    requiresReview: true,
    reviewReason: 'No entity matches found',
  }),
  mockLogMeeting: vi.fn().mockResolvedValue({
    activityid: 'activity-1',
    success: true,
    message: 'ok',
  }),
  mockEnqueue: vi.fn().mockResolvedValue('review-1'),
  mockUpdateStatus: vi.fn().mockResolvedValue(undefined),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

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
}));

vi.mock('../../shared/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    trackSignal: vi.fn(),
    trackDependency: vi.fn(),
  }),
}));

vi.mock('../../shared/dataverse-client.js', () => ({
  createDataverseClient: vi.fn().mockReturnValue({
    get: vi.fn().mockResolvedValue([]),
    getById: vi.fn(),
    executeAction: vi.fn(),
    create: vi.fn().mockResolvedValue('id'),
    update: vi.fn(),
  }),
}));

vi.mock('../../entity-matcher/index.js', () => ({
  createEntityMatcher: vi.fn().mockReturnValue({
    matchEntities: mockMatchEntities,
  }),
}));

vi.mock('../../confidence-scorer/index.js', () => ({
  createConfidenceScorer: vi.fn().mockReturnValue({
    score: mockScore,
  }),
}));

vi.mock('../../tool-dispatcher/index.js', () => ({
  createToolDispatcher: vi.fn().mockReturnValue({
    logMeeting: mockLogMeeting,
    createContact: vi.fn(),
  }),
}));

vi.mock('../../review-queue-manager/index.js', () => ({
  createReviewQueueManager: vi.fn().mockReturnValue({
    enqueue: mockEnqueue,
  }),
}));

vi.mock('../../signal-router/signal-log.js', () => ({
  createSignalLogService: vi.fn().mockReturnValue({
    exists: vi.fn().mockResolvedValue(false),
    create: vi.fn().mockResolvedValue('id'),
    updateStatus: mockUpdateStatus,
  }),
}));

// Import after all mocks
import { signalProcessorHandler } from '../index.js';

const testSignal = {
  id: 'signal-1',
  graphResourceId: 'graph-1',
  signalType: 'meeting' as const,
  tenantId: 'tenant-1',
  userId: 'user-1',
  userEmail: 'user@test.com',
  subject: 'Test Meeting',
  startTime: '2026-01-01T10:00:00Z',
  participants: [{ email: 'jane@partner.com' }],
  rawPayload: {},
  receivedAt: '2026-01-01T09:55:00Z',
};

const mockContext = {} as InvocationContext;

describe('signalProcessorHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes high-confidence signal to tool dispatcher', async () => {
    mockMatchEntities.mockResolvedValueOnce([
      { entityType: 'account', entityId: 'a1', entityName: 'Corp', matchField: 'contact-parent', matchValue: 'jane@partner.com', confidence: 0.95 },
      { entityType: 'contact', entityId: 'c1', entityName: 'Jane', matchField: 'emailaddress1', matchValue: 'jane@partner.com', confidence: 0.95 },
    ]);
    mockScore.mockReturnValueOnce({
      overallConfidence: 0.95,
      accountMatch: { entityType: 'account', entityId: 'a1', entityName: 'Corp', matchField: 'contact-parent', matchValue: 'jane@partner.com', confidence: 0.95 },
      contactMatches: [{ entityType: 'contact', entityId: 'c1', entityName: 'Jane', matchField: 'emailaddress1', matchValue: 'jane@partner.com', confidence: 0.95 }],
      requiresReview: false,
    });

    await signalProcessorHandler(testSignal, mockContext);

    expect(mockLogMeeting).toHaveBeenCalledWith(testSignal, expect.objectContaining({ overallConfidence: 0.95 }));
    expect(mockUpdateStatus).toHaveBeenCalledWith('signal-1', 'processed');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('routes low-confidence signal to review queue', async () => {
    mockMatchEntities.mockResolvedValueOnce([]);
    mockScore.mockReturnValueOnce({
      overallConfidence: 0,
      accountMatch: null,
      contactMatches: [],
      requiresReview: true,
      reviewReason: 'No entity matches found',
    });

    await signalProcessorHandler(testSignal, mockContext);

    expect(mockEnqueue).toHaveBeenCalledWith(testSignal, expect.objectContaining({ requiresReview: true }));
    expect(mockUpdateStatus).toHaveBeenCalledWith('signal-1', 'queued-for-review');
    expect(mockLogMeeting).not.toHaveBeenCalled();
  });

  it('routes to review queue when tool dispatch fails', async () => {
    mockMatchEntities.mockResolvedValueOnce([
      { entityType: 'account', entityId: 'a1', entityName: 'Corp', matchField: 'emailaddress1-domain', matchValue: 'partner.com', confidence: 0.70 },
    ]);
    mockScore.mockReturnValueOnce({
      overallConfidence: 0.70,
      accountMatch: { entityType: 'account', entityId: 'a1', entityName: 'Corp', matchField: 'emailaddress1-domain', matchValue: 'partner.com', confidence: 0.70 },
      contactMatches: [],
      requiresReview: false,
    });
    mockLogMeeting.mockResolvedValueOnce({
      activityid: '',
      success: false,
      message: 'Account not found',
    });

    await signalProcessorHandler(testSignal, mockContext);

    expect(mockEnqueue).toHaveBeenCalled();
    expect(mockUpdateStatus).toHaveBeenCalledWith('signal-1', 'queued-for-review', 'Account not found');
  });

  it('handles invalid signal message gracefully', async () => {
    await signalProcessorHandler({ invalid: true }, mockContext);

    expect(mockLoggerError).toHaveBeenCalled();
    expect(mockMatchEntities).not.toHaveBeenCalled();
  });

  it('re-throws errors for Service Bus retry', async () => {
    mockMatchEntities.mockRejectedValueOnce(new Error('Dataverse down'));

    await expect(signalProcessorHandler(testSignal, mockContext)).rejects.toThrow('Dataverse down');
    expect(mockUpdateStatus).toHaveBeenCalledWith('signal-1', 'failed', 'Dataverse down');
  });

  it('updates signal log to processing at start', async () => {
    mockMatchEntities.mockResolvedValueOnce([]);
    mockScore.mockReturnValueOnce({
      overallConfidence: 0,
      accountMatch: null,
      contactMatches: [],
      requiresReview: true,
      reviewReason: 'No matches',
    });

    await signalProcessorHandler(testSignal, mockContext);

    // First call to updateStatus should be 'processing'
    expect(mockUpdateStatus).toHaveBeenNthCalledWith(1, 'signal-1', 'processing');
  });
});
