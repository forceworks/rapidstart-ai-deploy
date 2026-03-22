import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createActivityGapDetector,
  getThresholdForStage,
  DEFAULT_STAGE_THRESHOLDS,
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

describe('getThresholdForStage', () => {
  it('returns correct threshold for Qualify stage by value', () => {
    expect(getThresholdForStage(undefined, 1)).toBe(14);
  });

  it('returns correct threshold for Close stage by value', () => {
    expect(getThresholdForStage(undefined, 4)).toBe(5);
  });

  it('returns correct threshold by stage name', () => {
    expect(getThresholdForStage('Propose', undefined)).toBe(7);
  });

  it('is case-insensitive for stage name', () => {
    expect(getThresholdForStage('develop', undefined)).toBe(10);
  });

  it('returns default threshold for unknown stage', () => {
    expect(getThresholdForStage('Custom Stage', 99)).toBe(14);
  });

  it('uses custom thresholds when provided', () => {
    const custom = [{ stageName: 'Custom', stageValue: 10, gapThresholdDays: 3 }];
    expect(getThresholdForStage('Custom', 10, custom)).toBe(3);
  });

  it('prefers stageValue match over stageName', () => {
    expect(getThresholdForStage('Qualify', 4)).toBe(5); // value 4 = Close (5 days)
  });
});

describe('createActivityGapDetector', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it('detects opportunities with activity gaps', async () => {
    const now = new Date();
    const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const mockGet = vi.fn()
      // Fetch open opportunities
      .mockResolvedValueOnce([
        {
          opportunityid: 'opp-stale',
          name: 'Stale Deal',
          stepname: 'Develop',
          salesstagecode: 2,
          fw_engagementscore: 0.3,
          fw_engagementtrend: 3,
          fw_lastsignaldate: twentyDaysAgo,
          fw_signalcount: 5,
          _parentaccountid_value: 'account-1',
        },
        {
          opportunityid: 'opp-active',
          name: 'Active Deal',
          stepname: 'Qualify',
          salesstagecode: 1,
          fw_engagementscore: 0.8,
          fw_engagementtrend: 1,
          fw_lastsignaldate: twoDaysAgo,
          fw_signalcount: 10,
          _parentaccountid_value: 'account-2',
        },
      ]);

    // Account name lookup for opp-stale
    const mockGetById = vi.fn().mockResolvedValue({ name: 'Stale Corp' });

    const client: DataverseClient = {
      get: mockGet,
      getById: mockGetById,
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const detector = createActivityGapDetector(client, mockLogger);
    const alerts = await detector.detectGaps();

    // opp-stale: 20 days > 10 (Develop threshold) → alert
    // opp-active: 2 days < 14 (Qualify threshold) → no alert
    expect(alerts).toHaveLength(1);
    expect(alerts[0].opportunityId).toBe('opp-stale');
    expect(alerts[0].opportunityName).toBe('Stale Deal');
    expect(alerts[0].accountName).toBe('Stale Corp');
    expect(alerts[0].daysSinceLastSignal).toBeGreaterThanOrEqual(19);
    expect(alerts[0].gapThresholdDays).toBe(10);
    expect(alerts[0].currentStage).toBe('Develop');
  });

  it('flags opportunities with no signal history', async () => {
    const mockGet = vi.fn().mockResolvedValueOnce([
      {
        opportunityid: 'opp-nosignal',
        name: 'No Signal Deal',
        stepname: 'Qualify',
        salesstagecode: 1,
        fw_signalcount: 0,
        // No fw_lastsignaldate
      },
    ]);

    const client: DataverseClient = {
      get: mockGet,
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const detector = createActivityGapDetector(client, mockLogger);
    const alerts = await detector.detectGaps();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].daysSinceLastSignal).toBe(999);
    expect(alerts[0].riskReason).toContain('No AI-captured activity');
  });

  it('returns empty array when Dataverse query fails', async () => {
    const client: DataverseClient = {
      get: vi.fn().mockRejectedValue(new Error('Dataverse unavailable')),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const detector = createActivityGapDetector(client, mockLogger);
    const alerts = await detector.detectGaps();

    expect(alerts).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('returns empty array when all opportunities are active', async () => {
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    const mockGet = vi.fn().mockResolvedValueOnce([
      {
        opportunityid: 'opp-1',
        name: 'Deal 1',
        stepname: 'Close',
        salesstagecode: 4,
        fw_lastsignaldate: recentDate,
      },
    ]);

    const client: DataverseClient = {
      get: mockGet,
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const detector = createActivityGapDetector(client, mockLogger);
    const alerts = await detector.detectGaps();

    expect(alerts).toHaveLength(0);
  });
});
