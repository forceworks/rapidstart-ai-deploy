import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createEngagementScorer,
  calculateRecencyScore,
  calculateFrequencyScore,
  determineTrend,
} from '../index.js';
import { type DataverseClient } from '../../shared/dataverse-client.js';
import { type Logger } from '../../shared/logger.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trackSignal: vi.fn(),
    trackDependency: vi.fn(),
  };
}

describe('calculateRecencyScore', () => {
  it('returns 1.0 for 0 days', () => {
    expect(calculateRecencyScore(0, 14)).toBe(1.0);
  });

  it('returns ~0.5 at half-life (14 days)', () => {
    expect(calculateRecencyScore(14, 14)).toBe(0.5);
  });

  it('returns ~0.25 at two half-lives (28 days)', () => {
    expect(calculateRecencyScore(28, 14)).toBe(0.25);
  });

  it('returns near 0 for very old signals', () => {
    const score = calculateRecencyScore(100, 14);
    expect(score).toBeLessThanOrEqual(0.01);
  });

  it('returns 1.0 for negative days', () => {
    expect(calculateRecencyScore(-1, 14)).toBe(1.0);
  });
});

describe('calculateFrequencyScore', () => {
  it('returns 0 for no signals', () => {
    expect(calculateFrequencyScore(0, 10)).toBe(0);
  });

  it('returns 0.5 for 5 out of 10 max', () => {
    expect(calculateFrequencyScore(5, 10)).toBe(0.5);
  });

  it('caps at 1.0 when exceeding max', () => {
    expect(calculateFrequencyScore(15, 10)).toBe(1.0);
  });

  it('returns 0.1 for 1 signal out of 10', () => {
    expect(calculateFrequencyScore(1, 10)).toBe(0.1);
  });
});

describe('determineTrend', () => {
  it('returns increasing when score improved by more than threshold', () => {
    expect(determineTrend(0.8, 0.5, 5)).toBe('increasing');
  });

  it('returns decreasing when score dropped by more than threshold', () => {
    expect(determineTrend(0.3, 0.6, 5)).toBe('decreasing');
  });

  it('returns stable when change is within threshold', () => {
    expect(determineTrend(0.55, 0.5, 5)).toBe('stable');
  });

  it('returns inactive when no signals for 60+ days', () => {
    expect(determineTrend(0.8, 0.5, 61)).toBe('inactive');
  });

  it('returns inactive regardless of scores when 60+ days', () => {
    expect(determineTrend(1.0, 0.0, 100)).toBe('inactive');
  });
});

describe('createEngagementScorer', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it('computes score for account with recent signals', async () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

    const mockGet = vi.fn()
      // Current period signals (30 days)
      .mockResolvedValueOnce([
        { fw_signallogid: 'log-1', fw_signalid: 's1', fw_createdon: twoDaysAgo, fw_status: 3 },
        { fw_signallogid: 'log-2', fw_signalid: 's2', fw_createdon: fiveDaysAgo, fw_status: 3 },
        { fw_signallogid: 'log-3', fw_signalid: 's3', fw_createdon: tenDaysAgo, fw_status: 3 },
      ])
      // Previous period signals (60 days)
      .mockResolvedValueOnce([
        { fw_signallogid: 'log-1', fw_signalid: 's1', fw_createdon: twoDaysAgo, fw_status: 3 },
        { fw_signallogid: 'log-2', fw_signalid: 's2', fw_createdon: fiveDaysAgo, fw_status: 3 },
        { fw_signallogid: 'log-3', fw_signalid: 's3', fw_createdon: tenDaysAgo, fw_status: 3 },
      ]);

    const mockGetById = vi.fn().mockResolvedValue({ name: 'Test Account' });

    const client: DataverseClient = {
      get: mockGet,
      getById: mockGetById,
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const scorer = createEngagementScorer(client, mockLogger);
    const score = await scorer.scoreAccount('account-1');

    expect(score.entityType).toBe('account');
    expect(score.entityId).toBe('account-1');
    expect(score.entityName).toBe('Test Account');
    expect(score.signalCount).toBe(3);
    expect(score.score).toBeGreaterThan(0);
    expect(score.recencyScore).toBeGreaterThan(0.5); // 2 days is recent
    expect(score.frequencyScore).toBe(0.3); // 3/10
    expect(score.daysSinceLastSignal).toBeLessThanOrEqual(3); // ~2 days
  });

  it('returns zero score for account with no signals', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce([]) // Current period
      .mockResolvedValueOnce([]); // Previous period

    const mockGetById = vi.fn().mockResolvedValue({ name: 'Empty Account' });

    const client: DataverseClient = {
      get: mockGet,
      getById: mockGetById,
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const scorer = createEngagementScorer(client, mockLogger);
    const score = await scorer.scoreAccount('account-empty');

    expect(score.signalCount).toBe(0);
    expect(score.score).toBe(0);
    expect(score.trend).toBe('inactive');
    expect(score.daysSinceLastSignal).toBe(999);
  });

  it('persists score to Dataverse', async () => {
    const mockUpdate = vi.fn().mockResolvedValue(undefined);
    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: mockUpdate,
    };

    const scorer = createEngagementScorer(client, mockLogger);
    await scorer.persistScore({
      entityType: 'account',
      entityId: 'account-1',
      entityName: 'Test',
      score: 0.75,
      recencyScore: 0.8,
      frequencyScore: 0.5,
      signalCount: 5,
      lastSignalDate: '2026-01-15T10:00:00Z',
      daysSinceLastSignal: 3,
      trend: 'increasing',
    });

    expect(mockUpdate).toHaveBeenCalledWith('accounts', 'account-1', expect.objectContaining({
      fw_engagementscore: 0.75,
      fw_engagementtrend: 1, // increasing = 1
      fw_signalcount: 5,
    }));
  });

  it('handles Dataverse errors gracefully during persist', async () => {
    const mockUpdate = vi.fn().mockRejectedValue(new Error('Dataverse error'));
    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: mockUpdate,
    };

    const scorer = createEngagementScorer(client, mockLogger);

    // Should not throw
    await scorer.persistScore({
      entityType: 'account',
      entityId: 'account-1',
      entityName: 'Test',
      score: 0.5,
      recencyScore: 0.5,
      frequencyScore: 0.5,
      signalCount: 3,
      lastSignalDate: '2026-01-15T10:00:00Z',
      daysSinceLastSignal: 5,
      trend: 'stable',
    });

    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('scores opportunity same as account', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce([]) // Current period
      .mockResolvedValueOnce([]); // Previous period

    const mockGetById = vi.fn().mockResolvedValue({ name: 'Big Deal' });

    const client: DataverseClient = {
      get: mockGet,
      getById: mockGetById,
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const scorer = createEngagementScorer(client, mockLogger);
    const score = await scorer.scoreOpportunity('opp-1');

    expect(score.entityType).toBe('opportunity');
    expect(score.entityId).toBe('opp-1');
    expect(score.entityName).toBe('Big Deal');
  });
});
