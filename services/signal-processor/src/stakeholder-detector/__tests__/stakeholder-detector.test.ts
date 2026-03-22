import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStakeholderDetector } from '../index.js';
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

function createMockDataverseClient(overrides: Partial<DataverseClient> = {}): DataverseClient {
  return {
    get: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue({}),
    executeAction: vi.fn(),
    create: vi.fn().mockResolvedValue('new-id'),
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const testSignal: Signal = {
  id: 'signal-1',
  graphResourceId: 'graph-1',
  signalType: 'meeting',
  tenantId: 'tenant-1',
  userId: 'user-1',
  userEmail: 'user@mycompany.com',
  subject: 'Deal Review',
  startTime: '2026-01-15T10:00:00Z',
  participants: [
    { email: 'jane@partner.com', displayName: 'Jane Smith' },
    { email: 'bob@partner.com', displayName: 'Bob Jones' },
    { email: 'unknown@newco.com', displayName: 'New Person' },
    { email: 'random@gmail.com', displayName: 'Gmail User' },
  ],
  rawPayload: {},
  receivedAt: '2026-01-15T09:55:00Z',
};

const janeContactMatch: EntityMatch = {
  entityType: 'contact',
  entityId: 'contact-jane',
  entityName: 'Jane Smith',
  matchField: 'emailaddress1',
  matchValue: 'jane@partner.com',
  confidence: 0.95,
};

const baseConfidenceResult: ConfidenceResult = {
  overallConfidence: 0.95,
  accountMatch: {
    entityType: 'account',
    entityId: 'account-partner',
    entityName: 'Partner Corp',
    matchField: 'contact-parent',
    matchValue: 'jane@partner.com',
    confidence: 0.95,
  },
  contactMatches: [janeContactMatch],
  requiresReview: false,
};

describe('stakeholderDetector', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it('identifies unknown participants not in CRM', async () => {
    const mockGet = vi.fn()
      // Contact lookup for bob@partner.com - not found
      .mockResolvedValueOnce([])
      // Account lookup for newco.com domain
      .mockResolvedValueOnce([{ accountid: 'account-newco', name: 'NewCo Inc' }])
      // Stakeholder occurrence lookup for bob@partner.com
      .mockResolvedValueOnce([])
      // Contact lookup for unknown@newco.com - not found
      .mockResolvedValueOnce([])
      // Account lookup for newco.com - already checked, returns again
      .mockResolvedValueOnce([{ accountid: 'account-newco', name: 'NewCo Inc' }])
      // Stakeholder occurrence lookup for unknown@newco.com
      .mockResolvedValueOnce([])
      // Contact lookup for random@gmail.com - not found
      .mockResolvedValueOnce([])
      // Stakeholder occurrence for random@gmail.com
      .mockResolvedValueOnce([]);

    const client = createMockDataverseClient({ get: mockGet });
    const detector = createStakeholderDetector(client, mockLogger);

    const result = await detector.detect(testSignal, baseConfidenceResult);

    // jane@partner.com is already matched in confidenceResult, should be in knownContacts
    expect(result.knownContacts).toHaveLength(1);
    expect(result.knownContacts[0].matchValue).toBe('jane@partner.com');

    // bob, unknown, and random should be unknown
    expect(result.unknownStakeholders.length).toBeGreaterThan(0);
  });

  it('skips the signal owner (user email)', async () => {
    const signalWithSelf: Signal = {
      ...testSignal,
      participants: [
        { email: 'user@mycompany.com', displayName: 'Me' }, // same as userEmail
        { email: 'external@other.com' },
      ],
    };

    const mockGet = vi.fn()
      // Contact lookup for external@other.com - not found
      .mockResolvedValueOnce([])
      // Account lookup for other.com
      .mockResolvedValueOnce([])
      // Stakeholder occurrence
      .mockResolvedValueOnce([]);

    const client = createMockDataverseClient({ get: mockGet });
    const detector = createStakeholderDetector(client, mockLogger);

    const emptyConfidence: ConfidenceResult = {
      overallConfidence: 0,
      accountMatch: null,
      contactMatches: [],
      requiresReview: true,
    };

    const result = await detector.detect(signalWithSelf, emptyConfidence);

    // The signal owner should NOT appear in unknown stakeholders
    const ownerInUnknown = result.unknownStakeholders.find(
      (s) => s.email === 'user@mycompany.com'
    );
    expect(ownerInUnknown).toBeUndefined();
  });

  it('flags new stakeholder in known account', async () => {
    const mockGet = vi.fn()
      // Contact lookup for bob@partner.com - not found
      .mockResolvedValueOnce([])
      // Account lookup for partner.com domain - found!
      .mockResolvedValueOnce([{ accountid: 'account-partner', name: 'Partner Corp' }])
      // Stakeholder occurrence lookup
      .mockResolvedValueOnce([])
      // Contact lookup for unknown@newco.com
      .mockResolvedValueOnce([])
      // Account lookup for newco.com
      .mockResolvedValueOnce([])
      // Stakeholder occurrence
      .mockResolvedValueOnce([])
      // Contact lookup for random@gmail.com
      .mockResolvedValueOnce([])
      // Stakeholder occurrence for gmail
      .mockResolvedValueOnce([]);

    const client = createMockDataverseClient({ get: mockGet });
    const detector = createStakeholderDetector(client, mockLogger);
    const result = await detector.detect(testSignal, baseConfidenceResult);

    expect(result.newStakeholderInKnownAccount).toBe(true);

    const bobStakeholder = result.unknownStakeholders.find((s) => s.email === 'bob@partner.com');
    expect(bobStakeholder).toBeDefined();
    expect(bobStakeholder!.suggestedAccountId).toBe('account-partner');
    expect(bobStakeholder!.suggestedAccountName).toBe('Partner Corp');
  });

  it('increments occurrence count for repeat unknown stakeholders', async () => {
    const mockGet = vi.fn()
      // Contact lookup - not found
      .mockResolvedValueOnce([])
      // Account lookup - not found
      .mockResolvedValueOnce([])
      // Stakeholder occurrence - found existing with count=3
      .mockResolvedValueOnce([{
        fw_stakeholderoccurrenceid: 'occ-1',
        fw_email: 'bob@partner.com',
        fw_count: 3,
        fw_lastseen: '2026-01-10T00:00:00Z',
      }]);

    const mockUpdate = vi.fn().mockResolvedValue(undefined);

    const singleParticipantSignal: Signal = {
      ...testSignal,
      participants: [{ email: 'bob@partner.com', displayName: 'Bob' }],
    };

    const emptyConfidence: ConfidenceResult = {
      overallConfidence: 0,
      accountMatch: null,
      contactMatches: [],
      requiresReview: true,
    };

    const client = createMockDataverseClient({ get: mockGet, update: mockUpdate });
    const detector = createStakeholderDetector(client, mockLogger);
    const result = await detector.detect(singleParticipantSignal, emptyConfidence);

    expect(result.unknownStakeholders).toHaveLength(1);
    expect(result.unknownStakeholders[0].occurrenceCount).toBe(4);
    expect(mockUpdate).toHaveBeenCalledWith(
      'fw_stakeholderoccurrences',
      'occ-1',
      expect.objectContaining({ fw_count: 4 })
    );
  });

  it('handles free email domains without account suggestion', async () => {
    const gmailSignal: Signal = {
      ...testSignal,
      participants: [{ email: 'someone@gmail.com' }],
    };

    const mockGet = vi.fn()
      // Contact lookup - not found
      .mockResolvedValueOnce([])
      // Stakeholder occurrence
      .mockResolvedValueOnce([]);

    const emptyConfidence: ConfidenceResult = {
      overallConfidence: 0,
      accountMatch: null,
      contactMatches: [],
      requiresReview: true,
    };

    const client = createMockDataverseClient({ get: mockGet });
    const detector = createStakeholderDetector(client, mockLogger);
    const result = await detector.detect(gmailSignal, emptyConfidence);

    expect(result.unknownStakeholders).toHaveLength(1);
    expect(result.unknownStakeholders[0].suggestedAccountId).toBeUndefined();
    expect(result.newStakeholderInKnownAccount).toBe(false);
  });
});
