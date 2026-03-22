import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createQueueClient } from '../queue-client.js';
import { type Signal } from '../types.js';
import { type Logger } from '../logger.js';

// Mock @azure/service-bus
const mockSendMessages = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@azure/service-bus', () => {
  class MockServiceBusClient {
    createSender = vi.fn().mockReturnValue({
      sendMessages: mockSendMessages,
      close: mockClose,
    });
    close = mockClose;
    constructor(_connectionString: string) {}
  }
  return { ServiceBusClient: MockServiceBusClient };
});

describe('queue-client', () => {
  let mockLogger: Logger;

  const testSignal: Signal = {
    id: 'signal-1',
    graphResourceId: 'graph-resource-1',
    signalType: 'meeting',
    tenantId: 'tenant-1',
    userId: 'user-1',
    userEmail: 'user@test.com',
    subject: 'Test Meeting',
    startTime: '2026-01-01T10:00:00Z',
    participants: [{ email: 'ext@company.com', displayName: 'External' }],
    rawPayload: {},
    receivedAt: '2026-01-01T09:55:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trackSignal: vi.fn(),
      trackDependency: vi.fn(),
    };
  });

  it('sends signal with graphResourceId as messageId', async () => {
    const client = createQueueClient('connection', 'signals', 'dlq', mockLogger);
    await client.sendSignal(testSignal);

    expect(mockSendMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        body: testSignal,
        messageId: 'graph-resource-1',
        contentType: 'application/json',
        subject: 'meeting',
      })
    );
  });

  it('sends to dead-letter queue with reason', async () => {
    const client = createQueueClient('connection', 'signals', 'dlq', mockLogger);
    await client.sendToDeadLetter(testSignal, 'processing-failed');

    expect(mockSendMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        body: testSignal,
        messageId: 'dlq-graph-resource-1',
        subject: 'dead-letter',
        applicationProperties: expect.objectContaining({
          reason: 'processing-failed',
        }),
      })
    );
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('tracks dependency on send', async () => {
    const client = createQueueClient('connection', 'signals', 'dlq', mockLogger);
    await client.sendSignal(testSignal);

    expect(mockLogger.trackDependency).toHaveBeenCalledWith(
      'ServiceBus.Send',
      expect.any(Number),
      true,
      'signals'
    );
  });
});
