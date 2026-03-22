import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InvocationContext } from '@azure/functions';

const {
  mockSendSignal,
  mockUpdateStatus,
  mockLoggerWarn,
  mockLoggerError,
  mockLoggerInfo,
} = vi.hoisted(() => ({
  mockSendSignal: vi.fn().mockResolvedValue(undefined),
  mockUpdateStatus: vi.fn().mockResolvedValue(undefined),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerInfo: vi.fn(),
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

vi.mock('../../shared/queue-client.js', () => ({
  createQueueClient: vi.fn().mockReturnValue({
    sendSignal: mockSendSignal,
    sendToDeadLetter: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../../signal-router/signal-log.js', () => ({
  createSignalLogService: vi.fn().mockReturnValue({
    exists: vi.fn().mockResolvedValue(false),
    create: vi.fn().mockResolvedValue('id'),
    updateStatus: mockUpdateStatus,
  }),
}));

import { deadLetterHandler } from '../index.js';

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

describe('deadLetterHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-enqueues signal when delivery count is below max', async () => {
    const context = { deliveryCount: 1 } as unknown as InvocationContext;

    await deadLetterHandler(testSignal, context);

    expect(mockUpdateStatus).toHaveBeenCalledWith('signal-1', 'dead-lettered', expect.stringContaining('1'));
    expect(mockSendSignal).toHaveBeenCalledWith(testSignal);
    expect(mockUpdateStatus).toHaveBeenCalledWith('signal-1', 'received', expect.stringContaining('Re-enqueued'));
  });

  it('permanently dead-letters signal at max retries', async () => {
    const context = { deliveryCount: 3 } as unknown as InvocationContext;

    await deadLetterHandler(testSignal, context);

    expect(mockSendSignal).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Signal permanently dead-lettered (max retries exceeded)',
      expect.objectContaining({ signalId: 'signal-1' })
    );
  });

  it('handles invalid message without crashing', async () => {
    const context = {} as InvocationContext;

    await deadLetterHandler({ invalid: true }, context);

    expect(mockLoggerError).toHaveBeenCalledWith(
      'Invalid dead-letter message',
      expect.any(Object)
    );
    expect(mockSendSignal).not.toHaveBeenCalled();
  });

  it('does not throw even when internal operations fail', async () => {
    mockUpdateStatus.mockRejectedValueOnce(new Error('DB error'));
    const context = { deliveryCount: 0 } as unknown as InvocationContext;

    // Should not throw
    await deadLetterHandler(testSignal, context);

    expect(mockLoggerError).toHaveBeenCalled();
  });
});
