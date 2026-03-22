import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createRiskAssessor,
  calculateRiskLevel,
  generateRecommendation,
} from '../index.js';
import { type DataverseClient } from '../../shared/dataverse-client.js';
import { type Logger } from '../../shared/logger.js';
import { type RiskFactor } from '../../shared/types.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trackSignal: vi.fn(),
    trackDependency: vi.fn(),
  };
}

describe('calculateRiskLevel', () => {
  it('returns low when no factors', () => {
    expect(calculateRiskLevel([])).toBe('low');
  });

  it('returns medium for single medium factor', () => {
    const factors: RiskFactor[] = [
      { type: 'activity-gap', severity: 'medium', description: 'test', data: {} },
    ];
    expect(calculateRiskLevel(factors)).toBe('medium');
  });

  it('returns high for single high factor', () => {
    const factors: RiskFactor[] = [
      { type: 'engagement-decline', severity: 'high', description: 'test', data: {} },
    ];
    expect(calculateRiskLevel(factors)).toBe('high');
  });

  it('returns high for one high + one medium factor', () => {
    const factors: RiskFactor[] = [
      { type: 'activity-gap', severity: 'high', description: 'test', data: {} },
      { type: 'sentiment-negative', severity: 'medium', description: 'test', data: {} },
    ];
    expect(calculateRiskLevel(factors)).toBe('high');
  });

  it('returns critical for 2+ high factors', () => {
    const factors: RiskFactor[] = [
      { type: 'activity-gap', severity: 'high', description: 'test', data: {} },
      { type: 'engagement-decline', severity: 'high', description: 'test', data: {} },
    ];
    expect(calculateRiskLevel(factors)).toBe('critical');
  });

  it('returns medium for 2 medium factors', () => {
    const factors: RiskFactor[] = [
      { type: 'activity-gap', severity: 'medium', description: 'test', data: {} },
      { type: 'new-stakeholder', severity: 'medium', description: 'test', data: {} },
    ];
    expect(calculateRiskLevel(factors)).toBe('medium');
  });
});

describe('generateRecommendation', () => {
  it('returns healthy message for no factors', () => {
    expect(generateRecommendation([])).toContain('healthy');
  });

  it('recommends scheduling meeting for activity gap', () => {
    const factors: RiskFactor[] = [
      { type: 'activity-gap', severity: 'medium', description: 'test', data: {} },
    ];
    expect(generateRecommendation(factors)).toContain('Schedule a meeting');
  });

  it('recommends reviewing engagement for decline', () => {
    const factors: RiskFactor[] = [
      { type: 'engagement-decline', severity: 'high', description: 'test', data: {} },
    ];
    expect(generateRecommendation(factors)).toContain('engagement');
  });

  it('recommends adding contacts for new stakeholders', () => {
    const factors: RiskFactor[] = [
      { type: 'new-stakeholder', severity: 'medium', description: 'test', data: {} },
    ];
    expect(generateRecommendation(factors)).toContain('stakeholders');
  });

  it('combines multiple recommendations', () => {
    const factors: RiskFactor[] = [
      { type: 'activity-gap', severity: 'high', description: 'test', data: {} },
      { type: 'sentiment-negative', severity: 'medium', description: 'test', data: {} },
    ];
    const rec = generateRecommendation(factors);
    expect(rec).toContain('Schedule');
    expect(rec).toContain('meeting notes');
  });
});

describe('createRiskAssessor', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it('assesses opportunity with activity gap and engagement decline', async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const mockGetById = vi.fn().mockResolvedValue({
      opportunityid: 'opp-1',
      name: 'Big Deal',
      stepname: 'Develop',
      salesstagecode: 2,
      fw_engagementscore: 0.2,
      fw_engagementtrend: 4, // inactive
      fw_lastsignaldate: thirtyDaysAgo,
      fw_signalcount: 3,
      _parentaccountid_value: 'account-1',
    });

    // Appointments query — returns empty (no recent meetings)
    const mockGet = vi.fn()
      .mockResolvedValueOnce([]) // appointments
      .mockResolvedValueOnce([]); // stakeholder occurrences

    const client: DataverseClient = {
      get: mockGet,
      getById: mockGetById,
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const assessor = createRiskAssessor(client, mockLogger);
    const result = await assessor.assess('opp-1');

    expect(result.isAtRisk).toBe(true);
    expect(result.riskFactors.length).toBeGreaterThanOrEqual(2);

    // Should have activity-gap and engagement-decline factors
    const types = result.riskFactors.map((f) => f.type);
    expect(types).toContain('activity-gap');
    expect(types).toContain('engagement-decline');
  });

  it('returns low risk for healthy opportunity', async () => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const mockGetById = vi.fn().mockResolvedValue({
      opportunityid: 'opp-healthy',
      name: 'Healthy Deal',
      stepname: 'Qualify',
      salesstagecode: 1,
      fw_engagementscore: 0.85,
      fw_engagementtrend: 1, // increasing
      fw_lastsignaldate: recentDate,
      fw_signalcount: 8,
    });

    const mockGet = vi.fn()
      .mockResolvedValueOnce([]) // no negative sentiment appointments
      .mockResolvedValueOnce([]); // no stakeholder concerns

    const client: DataverseClient = {
      get: mockGet,
      getById: mockGetById,
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const assessor = createRiskAssessor(client, mockLogger);
    const result = await assessor.assess('opp-healthy');

    expect(result.isAtRisk).toBe(false);
    expect(result.overallRiskLevel).toBe('low');
    expect(result.riskFactors).toHaveLength(0);
  });

  it('detects negative sentiment risk factor', async () => {
    const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const mockGetById = vi.fn().mockResolvedValue({
      opportunityid: 'opp-neg',
      name: 'Troubled Deal',
      stepname: 'Propose',
      salesstagecode: 3,
      fw_engagementscore: 0.6,
      fw_engagementtrend: 2, // stable
      fw_lastsignaldate: recentDate,
      fw_signalcount: 5,
    });

    const mockGet = vi.fn()
      // Appointments with negative sentiment
      .mockResolvedValueOnce([
        { activityid: 'a1', fw_sentiment: 3, scheduledstart: recentDate },
        { activityid: 'a2', fw_sentiment: 3, scheduledstart: recentDate },
      ]);

    const client: DataverseClient = {
      get: mockGet,
      getById: mockGetById,
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const assessor = createRiskAssessor(client, mockLogger);
    const result = await assessor.assess('opp-neg');

    expect(result.isAtRisk).toBe(true);
    const sentimentFactor = result.riskFactors.find((f) => f.type === 'sentiment-negative');
    expect(sentimentFactor).toBeDefined();
    expect(sentimentFactor!.severity).toBe('high'); // 2 negative meetings
  });

  it('flags at-risk via fw_FlagAtRisk Custom API', async () => {
    const mockExecuteAction = vi.fn().mockResolvedValue({
      success: true,
      message: 'Flagged',
    });

    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: mockExecuteAction,
      create: vi.fn(),
      update: vi.fn(),
    };

    const assessor = createRiskAssessor(client, mockLogger);
    const result = await assessor.flagAtRisk({
      opportunityId: 'opp-1',
      isAtRisk: true,
      riskFactors: [
        { type: 'activity-gap', severity: 'high', description: 'No activity for 30 days', data: {} },
      ],
      overallRiskLevel: 'high',
      recommendation: 'Schedule a meeting.',
    });

    expect(result.success).toBe(true);
    expect(mockExecuteAction).toHaveBeenCalledWith('fw_FlagAtRisk', expect.objectContaining({
      opportunityid: 'opp-1',
      risklevel: 'high',
    }));
  });

  it('skips flagging when opportunity is not at risk', async () => {
    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const assessor = createRiskAssessor(client, mockLogger);
    const result = await assessor.flagAtRisk({
      opportunityId: 'opp-safe',
      isAtRisk: false,
      riskFactors: [],
      overallRiskLevel: 'low',
      recommendation: 'All good.',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('not at risk');
    expect(client.executeAction).not.toHaveBeenCalled();
  });

  it('handles Dataverse error gracefully during assessment', async () => {
    const mockGetById = vi.fn().mockRejectedValue(new Error('Dataverse unavailable'));

    const client: DataverseClient = {
      get: vi.fn(),
      getById: mockGetById,
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const assessor = createRiskAssessor(client, mockLogger);
    const result = await assessor.assess('opp-error');

    expect(result.isAtRisk).toBe(false);
    expect(result.overallRiskLevel).toBe('low');
    expect(result.recommendation).toContain('Unable to assess');
  });
});
