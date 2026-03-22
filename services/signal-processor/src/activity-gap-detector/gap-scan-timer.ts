/**
 * Activity Gap Scan Timer — runs daily to detect activity gaps
 * in open opportunities and flag at-risk deals.
 *
 * Schedule: Every day at 6:00 AM UTC
 *
 * Flow:
 *   1. Detect activity gaps across all open opportunities
 *   2. For each gapped opportunity, run full risk assessment
 *   3. Flag at-risk opportunities via fw_FlagAtRisk Custom API
 *   4. Compute pipeline health metrics for manager dashboard
 */

import { app, type InvocationContext } from '@azure/functions';
import { loadConfig } from '../shared/config.js';
import { createTokenProvider } from '../shared/credentials.js';
import { createLogger } from '../shared/logger.js';
import { createDataverseClient } from '../shared/dataverse-client.js';
import { createActivityGapDetector } from './index.js';
import { createRiskAssessor } from '../risk-assessor/index.js';
import { type PipelineHealthMetrics } from '../shared/types.js';

export async function gapScanTimerHandler(
  timer: unknown,
  context: InvocationContext
): Promise<void> {
  const config = loadConfig();
  const tokenProvider = createTokenProvider(config.credentials);
  const logger = createLogger(config.logging.appInsightsConnectionString);
  const dataverseClient = createDataverseClient(
    config.dataverse.toolBaseUrl,
    tokenProvider,
    config.dataverse.url,
    logger
  );

  const gapDetector = createActivityGapDetector(dataverseClient, logger);
  const riskAssessor = createRiskAssessor(dataverseClient, logger);

  const startTime = Date.now();

  logger.info('Daily activity gap scan starting');

  try {
    // Step 1: Detect activity gaps
    const gapAlerts = await gapDetector.detectGaps();

    // Step 2: Run risk assessment and flag each at-risk opportunity
    let flaggedCount = 0;
    let failedCount = 0;

    const riskDistribution = { low: 0, medium: 0, high: 0, critical: 0 };
    const trendDistribution = { increasing: 0, stable: 0, decreasing: 0, inactive: 0 };

    for (const alert of gapAlerts) {
      try {
        const assessment = await riskAssessor.assess(alert.opportunityId);
        riskDistribution[assessment.overallRiskLevel]++;

        if (assessment.isAtRisk) {
          const flagResult = await riskAssessor.flagAtRisk(assessment);
          if (flagResult.success) {
            flaggedCount++;
          } else {
            failedCount++;
          }
        }
      } catch (error) {
        failedCount++;
        logger.warn('Risk assessment/flagging failed for opportunity', {
          opportunityId: alert.opportunityId,
          error: String(error),
        });
      }

      // Track trend distribution
      trendDistribution[alert.engagementTrend]++;
    }

    // Step 3: Build and persist pipeline health metrics
    const metrics: PipelineHealthMetrics = {
      totalOpportunities: gapAlerts.length, // Note: this is only at-risk ones from gap scan
      atRiskCount: flaggedCount,
      healthyCount: gapAlerts.length - flaggedCount,
      avgEngagementScore: gapAlerts.length > 0
        ? gapAlerts.reduce((sum, a) => sum + a.engagementScore, 0) / gapAlerts.length
        : 0,
      avgDaysSinceLastSignal: gapAlerts.length > 0
        ? gapAlerts.reduce((sum, a) => sum + a.daysSinceLastSignal, 0) / gapAlerts.length
        : 0,
      trendDistribution,
      riskDistribution,
      generatedAt: new Date().toISOString(),
    };

    // Persist metrics to a Dataverse config record for dashboard consumption
    try {
      const existingConfigs = await dataverseClient.get<{ fw_aitenantconfigid: string }>(
        'fw_aitenantconfigs',
        `$top=1&$select=fw_aitenantconfigid`
      );

      if (existingConfigs.length > 0) {
        await dataverseClient.update(
          'fw_aitenantconfigs',
          existingConfigs[0].fw_aitenantconfigid,
          {
            fw_pipelinehealthmetrics: JSON.stringify(metrics),
            fw_lastgapscandate: new Date().toISOString(),
          }
        );
      }
    } catch (error) {
      logger.warn('Failed to persist pipeline health metrics', { error: String(error) });
    }

    const durationMs = Date.now() - startTime;
    logger.info('Daily activity gap scan complete', {
      alertCount: String(gapAlerts.length),
      flaggedCount: String(flaggedCount),
      failedCount: String(failedCount),
      durationMs: String(durationMs),
      riskDistribution: JSON.stringify(riskDistribution),
    });
  } catch (error) {
    logger.error('Daily gap scan failed', {
      error: String(error),
      durationMs: String(Date.now() - startTime),
    });
  }
}

app.timer('activity-gap-scan', {
  schedule: '0 0 6 * * *', // Every day at 6:00 AM UTC
  handler: gapScanTimerHandler,
});
