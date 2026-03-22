/**
 * Engagement Trend Analyzer — periodically re-scores all active accounts
 * and opportunities to keep engagement scores and trends up to date.
 *
 * This service bridges the per-signal scoring (done inline during processing)
 * with a batch recalculation that catches stale entities whose scores
 * should decay over time even without new signals.
 *
 * Runs on a timer (default: every 6 hours).
 */

import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';
import { type EngagementScorerService } from '../engagement-scorer/index.js';

export interface EngagementTrendAnalyzerService {
  /** Re-score all open opportunities */
  refreshOpportunityScores(): Promise<TrendRefreshResult>;
  /** Re-score all active accounts (those with at least one open opportunity) */
  refreshAccountScores(): Promise<TrendRefreshResult>;
}

export interface TrendRefreshResult {
  entityType: 'account' | 'opportunity';
  totalScanned: number;
  updated: number;
  failed: number;
  trendChanges: TrendChange[];
  durationMs: number;
}

export interface TrendChange {
  entityId: string;
  entityName: string;
  previousTrend: string;
  newTrend: string;
  previousScore: number;
  newScore: number;
}

interface OpportunityRecord {
  opportunityid: string;
  name: string;
  fw_engagementscore?: number;
  fw_engagementtrend?: number;
  [key: string]: unknown;
}

interface AccountRecord {
  accountid: string;
  name: string;
  fw_engagementscore?: number;
  [key: string]: unknown;
  fw_engagementtrend?: number;
}

const TREND_MAP: Record<number, string> = {
  1: 'increasing',
  2: 'stable',
  3: 'decreasing',
  4: 'inactive',
};

export function createEngagementTrendAnalyzer(
  dataverseClient: DataverseClient,
  engagementScorer: EngagementScorerService,
  logger: Logger
): EngagementTrendAnalyzerService {
  async function refreshEntities<T extends Record<string, unknown> & { fw_engagementscore?: number; fw_engagementtrend?: number }>(
    entityType: 'account' | 'opportunity',
    entities: T[],
    idField: string,
    nameField: string,
    scoreFn: (id: string) => Promise<import('../shared/types.js').EngagementScore>
  ): Promise<TrendRefreshResult> {
    const startTime = Date.now();
    let updated = 0;
    let failed = 0;
    const trendChanges: TrendChange[] = [];

    for (const entity of entities) {
      const entityId = entity[idField] as string;
      const entityName = entity[nameField] as string;

      try {
        const previousTrend = TREND_MAP[entity.fw_engagementtrend || 4] || 'inactive';
        const previousScore = entity.fw_engagementscore || 0;

        const newScore = await scoreFn(entityId);
        await engagementScorer.persistScore(newScore);
        updated++;

        // Track trend changes for alerting
        if (previousTrend !== newScore.trend) {
          trendChanges.push({
            entityId,
            entityName,
            previousTrend,
            newTrend: newScore.trend,
            previousScore,
            newScore: newScore.score,
          });
        }
      } catch (error) {
        failed++;
        logger.warn('Failed to refresh engagement score', {
          entityType,
          entityId,
          error: String(error),
        });
      }
    }

    return {
      entityType,
      totalScanned: entities.length,
      updated,
      failed,
      trendChanges,
      durationMs: Date.now() - startTime,
    };
  }

  return {
    async refreshOpportunityScores(): Promise<TrendRefreshResult> {
      logger.info('Refreshing opportunity engagement scores');

      const opportunities = await dataverseClient.get<OpportunityRecord>(
        'opportunities',
        '$filter=statecode eq 0&$select=opportunityid,name,fw_engagementscore,fw_engagementtrend&$orderby=fw_engagementscoredon asc'
      );

      const result = await refreshEntities(
        'opportunity',
        opportunities,
        'opportunityid',
        'name',
        (id) => engagementScorer.scoreOpportunity(id)
      );

      logger.info('Opportunity engagement refresh complete', {
        total: String(result.totalScanned),
        updated: String(result.updated),
        failed: String(result.failed),
        trendChanges: String(result.trendChanges.length),
        durationMs: String(result.durationMs),
      });

      return result;
    },

    async refreshAccountScores(): Promise<TrendRefreshResult> {
      logger.info('Refreshing account engagement scores');

      // Only score accounts that have at least one open opportunity
      const accounts = await dataverseClient.get<AccountRecord>(
        'accounts',
        '$filter=openrevenue ne null&$select=accountid,name,fw_engagementscore,fw_engagementtrend&$orderby=fw_engagementscoredon asc'
      );

      const result = await refreshEntities(
        'account',
        accounts,
        'accountid',
        'name',
        (id) => engagementScorer.scoreAccount(id)
      );

      logger.info('Account engagement refresh complete', {
        total: String(result.totalScanned),
        updated: String(result.updated),
        failed: String(result.failed),
        trendChanges: String(result.trendChanges.length),
        durationMs: String(result.durationMs),
      });

      return result;
    },
  };
}
