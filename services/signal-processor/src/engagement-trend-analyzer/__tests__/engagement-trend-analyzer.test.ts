import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEngagementTrendAnalyzer } from '../index.js';
import { type DataverseClient } from '../../shared/dataverse-client.js';
import { type Logger } from '../../shared/logger.js';
import { type EngagementScorerService } from '../../engagement-scorer/index.js';
import { type EngagementScore } from '../../shared/types.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trackSignal: vi.fn(),
    trackDependency: vi.fn(),
  };
}

function createMockScorer(scoreFn?: (id: string) => EngagementScore): EngagementScorerService {
  const defaultScore = (id: string): EngagementScore => ({
    entityType: 'opportunity',
    entityId: id,
    entityName: 'Test',
    score: 0.5,
    recencyScore: 0.6,
    frequencyScore: 0.4,
    signalCount: 3,
    lastSignalDate: new Date().toISOString(),
    daysSinceLastSignal: 5,
    trend: 'stable',
  });

  return {
    scoreAccount: vi.fn().mockImplementation(async (id: string) => {
      const s = (scoreFn || defaultScore)(id);
      s.entityType = 'account';
      return s;
    }),
    scoreOpportunity: vi.fn().mockImplementation(async (id: string) => {
      return (scoreFn || defaultScore)(id);
    }),
    persistScore: vi.fn(),
  };
}

describe('createEngagementTrendAnalyzer', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it('refreshes opportunity scores and detects trend changes', async () => {
    const mockGet = vi.fn().mockResolvedValueOnce([
      {
        opportunityid: 'opp-1',
        name: 'Deal A',
        fw_engagementscore: 0.8,
        fw_engagementtrend: 1, // was increasing
      },
      {
        opportunityid: 'opp-2',
        name: 'Deal B',
        fw_engagementscore: 0.5,
        fw_engagementtrend: 2, // was stable
      },
    ]);

    const client: DataverseClient = {
      get: mockGet,
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    // opp-1 stays increasing, opp-2 changes to decreasing
    const scorer = createMockScorer((id) => ({
      entityType: 'opportunity',
      entityId: id,
      entityName: id === 'opp-1' ? 'Deal A' : 'Deal B',
      score: id === 'opp-1' ? 0.75 : 0.3,
      recencyScore: 0.5,
      frequencyScore: 0.3,
      signalCount: 2,
      lastSignalDate: new Date().toISOString(),
      daysSinceLastSignal: 7,
      trend: id === 'opp-1' ? 'increasing' : 'decreasing',
    }));

    const analyzer = createEngagementTrendAnalyzer(client, scorer, mockLogger);
    const result = await analyzer.refreshOpportunityScores();

    expect(result.totalScanned).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.failed).toBe(0);
    expect(scorer.persistScore).toHaveBeenCalledTimes(2);

    // opp-2 changed from stable to decreasing
    expect(result.trendChanges).toHaveLength(1);
    expect(result.trendChanges[0].entityId).toBe('opp-2');
    expect(result.trendChanges[0].previousTrend).toBe('stable');
    expect(result.trendChanges[0].newTrend).toBe('decreasing');
  });

  it('refreshes account scores', async () => {
    const mockGet = vi.fn().mockResolvedValueOnce([
      { accountid: 'acc-1', name: 'Contoso', fw_engagementscore: 0.6, fw_engagementtrend: 2 },
    ]);

    const client: DataverseClient = {
      get: mockGet,
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const scorer = createMockScorer();
    const analyzer = createEngagementTrendAnalyzer(client, scorer, mockLogger);
    const result = await analyzer.refreshAccountScores();

    expect(result.entityType).toBe('account');
    expect(result.totalScanned).toBe(1);
    expect(result.updated).toBe(1);
    expect(scorer.scoreAccount).toHaveBeenCalledWith('acc-1');
    expect(scorer.persistScore).toHaveBeenCalledTimes(1);
  });

  it('handles scoring failures gracefully', async () => {
    const mockGet = vi.fn().mockResolvedValueOnce([
      { opportunityid: 'opp-ok', name: 'Good Deal', fw_engagementscore: 0.5, fw_engagementtrend: 2 },
      { opportunityid: 'opp-fail', name: 'Bad Deal', fw_engagementscore: 0.3, fw_engagementtrend: 3 },
    ]);

    const client: DataverseClient = {
      get: mockGet,
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const scorer = createMockScorer();
    (scorer.scoreOpportunity as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        entityType: 'opportunity', entityId: 'opp-ok', entityName: 'Good Deal',
        score: 0.5, recencyScore: 0.5, frequencyScore: 0.5, signalCount: 3,
        lastSignalDate: '', daysSinceLastSignal: 5, trend: 'stable',
      })
      .mockRejectedValueOnce(new Error('Dataverse unavailable'));

    const analyzer = createEngagementTrendAnalyzer(client, scorer, mockLogger);
    const result = await analyzer.refreshOpportunityScores();

    expect(result.totalScanned).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.failed).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('returns empty result when no entities found', async () => {
    const client: DataverseClient = {
      get: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const scorer = createMockScorer();
    const analyzer = createEngagementTrendAnalyzer(client, scorer, mockLogger);
    const result = await analyzer.refreshOpportunityScores();

    expect(result.totalScanned).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.trendChanges).toHaveLength(0);
  });
});
