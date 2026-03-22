/**
 * Engagement Scorer — computes engagement scores for accounts and opportunities
 * based on signal recency and frequency.
 *
 * Scoring formula:
 *   score = (recencyScore * RECENCY_WEIGHT) + (frequencyScore * FREQUENCY_WEIGHT)
 *
 * Recency: exponential decay based on days since last signal
 *   - 0 days: 1.0, 7 days: ~0.7, 14 days: ~0.5, 30 days: ~0.25, 60+ days: ~0.05
 *
 * Frequency: normalized count of signals in the scoring window
 *   - 10+ signals/month: 1.0, 5 signals: 0.5, 1 signal: 0.1
 *
 * Trend: compares current period score to previous period.
 */

import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';
import { type EngagementScore } from '../shared/types.js';

export interface EngagementScorerService {
  /** Compute engagement score for an account */
  scoreAccount(accountId: string): Promise<EngagementScore>;
  /** Compute engagement score for an opportunity */
  scoreOpportunity(opportunityId: string): Promise<EngagementScore>;
  /** Store the computed score in Dataverse */
  persistScore(score: EngagementScore): Promise<void>;
}

export interface EngagementScorerOptions {
  /** Window in days for frequency counting (default: 30) */
  frequencyWindowDays?: number;
  /** Half-life in days for recency decay (default: 14) */
  recencyHalfLifeDays?: number;
  /** Weight for recency component (default: 0.6) */
  recencyWeight?: number;
  /** Weight for frequency component (default: 0.4) */
  frequencyWeight?: number;
  /** Signals per month that maps to frequency score 1.0 (default: 10) */
  frequencyMaxSignals?: number;
}

interface SignalLogRecord {
  fw_signallogid: string;
  fw_signalid: string;
  fw_createdon: string;
  fw_status: number;
}

const DEFAULT_OPTIONS: Required<EngagementScorerOptions> = {
  frequencyWindowDays: 30,
  recencyHalfLifeDays: 14,
  recencyWeight: 0.6,
  frequencyWeight: 0.4,
  frequencyMaxSignals: 10,
};

/**
 * Calculate recency score using exponential decay.
 * score = 2^(-days / halfLife)
 */
export function calculateRecencyScore(
  daysSinceLastSignal: number,
  halfLifeDays: number
): number {
  if (daysSinceLastSignal <= 0) return 1.0;
  const score = Math.pow(2, -daysSinceLastSignal / halfLifeDays);
  return Math.round(score * 100) / 100;
}

/**
 * Calculate frequency score as a normalized ratio.
 * score = min(signalCount / maxSignals, 1.0)
 */
export function calculateFrequencyScore(
  signalCount: number,
  maxSignals: number
): number {
  if (signalCount <= 0) return 0;
  const score = Math.min(signalCount / maxSignals, 1.0);
  return Math.round(score * 100) / 100;
}

/**
 * Determine the engagement trend by comparing current vs previous period.
 */
export function determineTrend(
  currentScore: number,
  previousScore: number,
  daysSinceLastSignal: number
): 'increasing' | 'stable' | 'decreasing' | 'inactive' {
  if (daysSinceLastSignal > 60) return 'inactive';

  const delta = currentScore - previousScore;
  const threshold = 0.1; // 10% change threshold

  if (delta > threshold) return 'increasing';
  if (delta < -threshold) return 'decreasing';
  return 'stable';
}

export function createEngagementScorer(
  dataverseClient: DataverseClient,
  logger: Logger,
  options?: EngagementScorerOptions
): EngagementScorerService {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  /**
   * Fetch signal logs for an entity within a time window.
   */
  async function fetchSignalLogs(
    entityType: 'account' | 'opportunity',
    entityId: string,
    windowDays: number
  ): Promise<SignalLogRecord[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - windowDays);
    const cutoffIso = cutoffDate.toISOString();

    const entityFilter = entityType === 'account'
      ? `fw_accountid eq '${entityId}'`
      : `fw_opportunityid eq '${entityId}'`;

    // Only count processed signals (status = 'processed' mapped to 3 in our schema)
    const filter = `${entityFilter} and fw_createdon ge ${cutoffIso} and fw_status eq 3`;

    try {
      return await dataverseClient.get<SignalLogRecord>(
        'fw_signallogs',
        `$filter=${filter}&$select=fw_signallogid,fw_signalid,fw_createdon,fw_status&$orderby=fw_createdon desc`
      );
    } catch (error) {
      logger.warn('Failed to fetch signal logs for engagement scoring', {
        entityType,
        entityId,
        error: String(error),
      });
      return [];
    }
  }

  /**
   * Get entity name for display purposes.
   */
  async function getEntityName(
    entityType: 'account' | 'opportunity',
    entityId: string
  ): Promise<string> {
    try {
      if (entityType === 'account') {
        const account = await dataverseClient.getById<{ name: string }>(
          'accounts', entityId, ['name']
        );
        return account.name;
      } else {
        const opp = await dataverseClient.getById<{ name: string }>(
          'opportunities', entityId, ['name']
        );
        return opp.name;
      }
    } catch {
      return entityId;
    }
  }

  /**
   * Core scoring logic shared between account and opportunity scoring.
   */
  async function computeScore(
    entityType: 'account' | 'opportunity',
    entityId: string
  ): Promise<EngagementScore> {
    // Fetch current period signals
    const currentSignals = await fetchSignalLogs(entityType, entityId, opts.frequencyWindowDays);

    // Fetch previous period signals for trend comparison
    const previousSignals = await fetchSignalLogs(entityType, entityId, opts.frequencyWindowDays * 2);
    const previousOnlySignals = previousSignals.filter(
      (s) => !currentSignals.some((c) => c.fw_signallogid === s.fw_signallogid)
    );

    const entityName = await getEntityName(entityType, entityId);
    const now = new Date();

    // Calculate days since last signal
    let daysSinceLastSignal: number;
    let lastSignalDate: string;

    if (currentSignals.length > 0) {
      const lastDate = new Date(currentSignals[0].fw_createdon);
      daysSinceLastSignal = Math.floor(
        (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      lastSignalDate = currentSignals[0].fw_createdon;
    } else if (previousOnlySignals.length > 0) {
      const lastDate = new Date(previousOnlySignals[0].fw_createdon);
      daysSinceLastSignal = Math.floor(
        (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      lastSignalDate = previousOnlySignals[0].fw_createdon;
    } else {
      daysSinceLastSignal = 999;
      lastSignalDate = '';
    }

    // Compute scores
    const recencyScore = calculateRecencyScore(daysSinceLastSignal, opts.recencyHalfLifeDays);
    const frequencyScore = calculateFrequencyScore(currentSignals.length, opts.frequencyMaxSignals);
    const currentScore = (recencyScore * opts.recencyWeight) + (frequencyScore * opts.frequencyWeight);

    // Previous period scores for trend
    const prevFrequencyScore = calculateFrequencyScore(previousOnlySignals.length, opts.frequencyMaxSignals);
    const previousScore = prevFrequencyScore * opts.frequencyWeight; // Recency doesn't apply to previous period

    const trend = determineTrend(currentScore, previousScore, daysSinceLastSignal);

    const score: EngagementScore = {
      entityType,
      entityId,
      entityName,
      score: Math.round(currentScore * 100) / 100,
      recencyScore,
      frequencyScore,
      signalCount: currentSignals.length,
      lastSignalDate,
      daysSinceLastSignal,
      trend,
    };

    logger.info('Engagement score computed', {
      entityType,
      entityId,
      score: String(score.score),
      recency: String(recencyScore),
      frequency: String(frequencyScore),
      signals: String(currentSignals.length),
      trend,
    });

    return score;
  }

  return {
    async scoreAccount(accountId: string): Promise<EngagementScore> {
      return computeScore('account', accountId);
    },

    async scoreOpportunity(opportunityId: string): Promise<EngagementScore> {
      return computeScore('opportunity', opportunityId);
    },

    async persistScore(score: EngagementScore): Promise<void> {
      try {
        const entitySet = score.entityType === 'account' ? 'accounts' : 'opportunities';
        await dataverseClient.update(entitySet, score.entityId, {
          fw_engagementscore: score.score,
          fw_engagementtrend: trendToNumber(score.trend),
          fw_lastsignaldate: score.lastSignalDate || null,
          fw_signalcount: score.signalCount,
          fw_engagementscoredon: new Date().toISOString(),
        });

        logger.info('Engagement score persisted', {
          entityType: score.entityType,
          entityId: score.entityId,
          score: String(score.score),
        });
      } catch (error) {
        logger.warn('Failed to persist engagement score', {
          entityType: score.entityType,
          entityId: score.entityId,
          error: String(error),
        });
      }
    },
  };
}

function trendToNumber(trend: string): number {
  switch (trend) {
    case 'increasing': return 1;
    case 'stable': return 2;
    case 'decreasing': return 3;
    case 'inactive': return 4;
    default: return 2;
  }
}
