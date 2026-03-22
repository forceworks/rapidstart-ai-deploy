/**
 * Activity Gap Detector — timer-triggered function that scans open opportunities
 * for activity gaps and flags them as at-risk.
 *
 * Runs daily. For each open opportunity:
 *   1. Check days since last signal against stage-specific threshold
 *   2. If gap exceeds threshold → flag via fw_FlagAtRisk Custom API
 *   3. Log results for AI Health Dashboard
 *
 * Stage-specific thresholds (configurable per tenant):
 *   - Qualify: 14 days
 *   - Develop: 10 days
 *   - Propose: 7 days
 *   - Close: 5 days
 *   - Default: 14 days
 */

import { app, type InvocationContext } from '@azure/functions';
import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';
import { type ActivityGapAlert, type StageGapThreshold } from '../shared/types.js';

export interface ActivityGapDetectorService {
  /** Scan all open opportunities and return those with activity gaps */
  detectGaps(): Promise<ActivityGapAlert[]>;
}

/** Default gap thresholds per opportunity stage */
export const DEFAULT_STAGE_THRESHOLDS: StageGapThreshold[] = [
  { stageName: 'Qualify', stageValue: 1, gapThresholdDays: 14 },
  { stageName: 'Develop', stageValue: 2, gapThresholdDays: 10 },
  { stageName: 'Propose', stageValue: 3, gapThresholdDays: 7 },
  { stageName: 'Close', stageValue: 4, gapThresholdDays: 5 },
];

const DEFAULT_GAP_THRESHOLD = 14;

interface OpportunityRecord {
  opportunityid: string;
  name: string;
  stepname?: string;
  salesstagecode?: number;
  fw_engagementscore?: number;
  fw_engagementtrend?: number;
  fw_lastsignaldate?: string;
  fw_signalcount?: number;
  _parentaccountid_value?: string;
}

interface AccountNameRecord {
  name: string;
}

/**
 * Look up the gap threshold for a given stage.
 */
export function getThresholdForStage(
  stageName: string | undefined,
  stageValue: number | undefined,
  customThresholds?: StageGapThreshold[]
): number {
  const thresholds = customThresholds || DEFAULT_STAGE_THRESHOLDS;

  if (stageValue !== undefined) {
    const byValue = thresholds.find((t) => t.stageValue === stageValue);
    if (byValue) return byValue.gapThresholdDays;
  }

  if (stageName) {
    const byName = thresholds.find(
      (t) => t.stageName.toLowerCase() === stageName.toLowerCase()
    );
    if (byName) return byName.gapThresholdDays;
  }

  return DEFAULT_GAP_THRESHOLD;
}

export function createActivityGapDetector(
  dataverseClient: DataverseClient,
  logger: Logger,
  customThresholds?: StageGapThreshold[]
): ActivityGapDetectorService {
  return {
    async detectGaps(): Promise<ActivityGapAlert[]> {
      const startTime = Date.now();
      const alerts: ActivityGapAlert[] = [];

      try {
        // Fetch all open opportunities with engagement data
        const opportunities = await dataverseClient.get<OpportunityRecord>(
          'opportunities',
          `$filter=statecode eq 0&$select=opportunityid,name,stepname,salesstagecode,fw_engagementscore,fw_engagementtrend,fw_lastsignaldate,fw_signalcount,_parentaccountid_value&$orderby=fw_engagementscore asc`
        );

        logger.info('Activity gap scan started', {
          opportunityCount: String(opportunities.length),
        });

        const now = new Date();

        for (const opp of opportunities) {
          const threshold = getThresholdForStage(
            opp.stepname,
            opp.salesstagecode,
            customThresholds
          );

          // Calculate days since last signal
          let daysSinceLastSignal: number;
          if (opp.fw_lastsignaldate) {
            const lastDate = new Date(opp.fw_lastsignaldate);
            daysSinceLastSignal = Math.floor(
              (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
            );
          } else {
            daysSinceLastSignal = 999; // Never had a signal
          }

          // Check if gap exceeds threshold
          if (daysSinceLastSignal > threshold) {
            // Look up account name
            let accountName: string | undefined;
            if (opp._parentaccountid_value) {
              try {
                const account = await dataverseClient.getById<AccountNameRecord>(
                  'accounts',
                  opp._parentaccountid_value,
                  ['name']
                );
                accountName = account.name;
              } catch {
                // Non-critical — proceed without account name
              }
            }

            const trendMap: Record<number, ActivityGapAlert['engagementTrend']> = {
              1: 'increasing', 2: 'stable', 3: 'decreasing', 4: 'inactive',
            };

            const riskReason = opp.fw_lastsignaldate
              ? `No activity for ${daysSinceLastSignal} days (threshold: ${threshold} days for ${opp.stepname || 'current'} stage)`
              : `No AI-captured activity detected for this opportunity`;

            alerts.push({
              opportunityId: opp.opportunityid,
              opportunityName: opp.name,
              accountId: opp._parentaccountid_value,
              accountName,
              currentStage: opp.stepname || 'Unknown',
              daysSinceLastSignal,
              gapThresholdDays: threshold,
              engagementScore: opp.fw_engagementscore || 0,
              engagementTrend: trendMap[opp.fw_engagementtrend || 4] || 'inactive',
              riskReason,
            });
          }
        }

        const durationMs = Date.now() - startTime;
        logger.info('Activity gap scan complete', {
          totalOpportunities: String(opportunities.length),
          atRiskCount: String(alerts.length),
          durationMs: String(durationMs),
        });

        return alerts;
      } catch (error) {
        logger.error('Activity gap detection failed', {
          error: String(error),
          durationMs: String(Date.now() - startTime),
        });
        return [];
      }
    },
  };
}
