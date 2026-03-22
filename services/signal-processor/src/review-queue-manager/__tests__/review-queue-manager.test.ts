import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createReviewQueueManager } from '../index.js';
import { type DataverseClient } from '../../shared/dataverse-client.js';
import { type Logger } from '../../shared/logger.js';
import { type Signal, type ConfidenceResult } from '../../shared/types.js';

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
  subject: 'Ambiguous Meeting',
  startTime: '2026-01-01T10:00:00Z',
  participants: [
    { email: 'jane@unknown.com' },
  ],
  rawPayload: {},
  receivedAt: '2026-01-01T09:55:00Z',
};

describe('reviewQueueManager', () => {
  let mockLogger: Logger;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockCreate = vi.fn().mockResolvedValue('review-queue-1');
  });

  it('creates a review queue record with correct fields', async () => {
    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: mockCreate,
      update: vi.fn(),
    };

    const confidenceResult: ConfidenceResult = {
      overallConfidence: 0.50,
      accountMatch: null,
      contactMatches: [],
      requiresReview: true,
      reviewReason: 'Ambiguous: 2 potential account matches',
    };

    const manager = createReviewQueueManager(client, mockLogger);
    const id = await manager.enqueue(testSignal, confidenceResult);

    expect(id).toBe('review-queue-1');
    expect(mockCreate).toHaveBeenCalledWith(
      'fw_reviewqueues',
      expect.objectContaining({
        fw_signalid: 'signal-1',
        fw_graphresourceid: 'graph-1',
        fw_subject: 'Ambiguous Meeting',
        fw_confidencescore: 0.50,
        fw_reviewreason: 'Ambiguous: 2 potential account matches',
        fw_status: 1, // pending
      })
    );
  });

  it('links suggested account when available', async () => {
    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: mockCreate,
      update: vi.fn(),
    };

    const confidenceResult: ConfidenceResult = {
      overallConfidence: 0.60,
      accountMatch: {
        entityType: 'account',
        entityId: 'account-1',
        entityName: 'Possible Corp',
        matchField: 'websiteurl',
        matchValue: 'possible.com',
        confidence: 0.60,
      },
      contactMatches: [],
      requiresReview: true,
      reviewReason: 'Contact found but no associated account',
    };

    const manager = createReviewQueueManager(client, mockLogger);
    await manager.enqueue(testSignal, confidenceResult);

    const createCall = mockCreate.mock.calls[0][1];
    expect(createCall['fw_suggestedaccountid@odata.bind']).toBe('/accounts(account-1)');
  });

  it('stores serialized signal and entity matches', async () => {
    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: mockCreate,
      update: vi.fn(),
    };

    const confidenceResult: ConfidenceResult = {
      overallConfidence: 0,
      accountMatch: null,
      contactMatches: [],
      requiresReview: true,
      reviewReason: 'No entity matches found',
    };

    const manager = createReviewQueueManager(client, mockLogger);
    await manager.enqueue(testSignal, confidenceResult);

    const createCall = mockCreate.mock.calls[0][1];
    expect(createCall.fw_signalpayload).toBe(JSON.stringify(testSignal));
    expect(createCall.fw_entitymatches).toBe(JSON.stringify(confidenceResult));
  });

  it('tracks signal on enqueue', async () => {
    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: mockCreate,
      update: vi.fn(),
    };

    const confidenceResult: ConfidenceResult = {
      overallConfidence: 0,
      accountMatch: null,
      contactMatches: [],
      requiresReview: true,
      reviewReason: 'No matches',
    };

    const manager = createReviewQueueManager(client, mockLogger);
    await manager.enqueue(testSignal, confidenceResult);

    expect(mockLogger.trackSignal).toHaveBeenCalledWith(
      'signal-1',
      'queued-for-review',
      expect.objectContaining({ reviewQueueId: 'review-queue-1' })
    );
  });
});
