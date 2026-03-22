import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createToolDispatcher } from '../index.js';
import { type DataverseClient } from '../../shared/dataverse-client.js';
import { type Logger } from '../../shared/logger.js';
import { type Signal, type ConfidenceResult, type EntityMatch } from '../../shared/types.js';

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
  subject: 'Quarterly Review',
  startTime: '2026-01-01T10:00:00Z',
  endTime: '2026-01-01T11:00:00Z',
  participants: [
    { email: 'jane@partner.com', displayName: 'Jane' },
    { email: 'bob@partner.com', displayName: 'Bob' },
  ],
  rawPayload: {},
  receivedAt: '2026-01-01T09:55:00Z',
};

const accountMatch: EntityMatch = {
  entityType: 'account',
  entityId: 'account-1',
  entityName: 'Partner Corp',
  matchField: 'contact-parent',
  matchValue: 'jane@partner.com',
  confidence: 0.95,
};

const confidenceResult: ConfidenceResult = {
  overallConfidence: 0.95,
  accountMatch,
  contactMatches: [],
  requiresReview: false,
};

describe('toolDispatcher', () => {
  let mockLogger: Logger;
  let mockExecuteAction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockExecuteAction = vi.fn();
  });

  it('calls fw_LogMeeting with correct parameters', async () => {
    mockExecuteAction.mockResolvedValue({
      activityid: 'activity-1',
      success: true,
      message: 'Meeting logged',
    });

    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: mockExecuteAction,
      create: vi.fn(),
      update: vi.fn(),
    };

    const dispatcher = createToolDispatcher(client, mockLogger);
    const result = await dispatcher.logMeeting(testSignal, confidenceResult);

    expect(mockExecuteAction).toHaveBeenCalledWith('fw_LogMeeting', {
      accountid: 'account-1',
      meetingsubject: 'Quarterly Review',
      meetingstart: '2026-01-01T10:00:00Z',
      meetingend: '2026-01-01T11:00:00Z',
      participantemails: 'jane@partner.com;bob@partner.com',
      confidencescore: 0.95,
      signalid: 'signal-1',
      graphresourceid: 'graph-1',
    });

    expect(result.success).toBe(true);
    expect(result.activityid).toBe('activity-1');
  });

  it('omits accountid when no account match', async () => {
    mockExecuteAction.mockResolvedValue({
      activityid: 'activity-2',
      success: true,
      message: 'Meeting logged without account',
    });

    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: mockExecuteAction,
      create: vi.fn(),
      update: vi.fn(),
    };

    const noAccountResult: ConfidenceResult = {
      overallConfidence: 0.60,
      accountMatch: null,
      contactMatches: [],
      requiresReview: false,
    };

    const dispatcher = createToolDispatcher(client, mockLogger);
    await dispatcher.logMeeting(testSignal, noAccountResult);

    const call = mockExecuteAction.mock.calls[0];
    expect(call[1].accountid).toBeUndefined();
  });

  it('calls fw_CreateContact with correct parameters', async () => {
    mockExecuteAction.mockResolvedValue({
      contactid: 'contact-1',
      success: true,
      message: 'Contact created',
      alreadyexisted: false,
    });

    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: mockExecuteAction,
      create: vi.fn(),
      update: vi.fn(),
    };

    const dispatcher = createToolDispatcher(client, mockLogger);
    const result = await dispatcher.createContact('jane@partner.com', 'Jane Smith', 'account-1');

    expect(mockExecuteAction).toHaveBeenCalledWith('fw_CreateContact', {
      email: 'jane@partner.com',
      displayname: 'Jane Smith',
      accountid: 'account-1',
    });

    expect(result.success).toBe(true);
    expect(result.contactid).toBe('contact-1');
    expect(result.alreadyexisted).toBe(false);
  });

  it('tracks signal on successful meeting log', async () => {
    mockExecuteAction.mockResolvedValue({
      activityid: 'activity-1',
      success: true,
      message: 'ok',
    });

    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: mockExecuteAction,
      create: vi.fn(),
      update: vi.fn(),
    };

    const dispatcher = createToolDispatcher(client, mockLogger);
    await dispatcher.logMeeting(testSignal, confidenceResult);

    expect(mockLogger.trackSignal).toHaveBeenCalledWith(
      'signal-1',
      'meeting-logged',
      expect.objectContaining({ activityId: 'activity-1' })
    );
  });
});
