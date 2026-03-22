/**
 * Engagement Trend Refresh Timer — runs every 6 hours to recalculate
 * engagement scores and detect trend changes across all active entities.
 *
 * Schedule: Every 6 hours
 *
 * Flow:
 *   1. Refresh all open opportunity scores
 *   2. Refresh all active account scores
 *   3. Log trend changes for dashboard consumption
 */

import { app, type InvocationContext } from '@azure/functions';
import { loadConfig } from '../shared/config.js';
import { createTokenProvider } from '../shared/credentials.js';
import { createLogger } from '../shared/logger.js';
import { createDataverseClient } from '../shared/dataverse-client.js';
import { createEngagementScorer } from '../engagement-scorer/index.js';
import { createEngagementTrendAnalyzer } from './index.js';

export async function trendRefreshTimerHandler(
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

  const engagementScorer = createEngagementScorer(dataverseClient, logger);
  const trendAnalyzer = createEngagementTrendAnalyzer(
    dataverseClient,
    engagementScorer,
    logger
  );

  const startTime = Date.now();
  logger.info('Engagement trend refresh starting');

  try {
    const oppResult = await trendAnalyzer.refreshOpportunityScores();
    const accountResult = await trendAnalyzer.refreshAccountScores();

    const durationMs = Date.now() - startTime;
    logger.info('Engagement trend refresh complete', {
      oppScanned: String(oppResult.totalScanned),
      oppUpdated: String(oppResult.updated),
      oppTrendChanges: String(oppResult.trendChanges.length),
      accountScanned: String(accountResult.totalScanned),
      accountUpdated: String(accountResult.updated),
      accountTrendChanges: String(accountResult.trendChanges.length),
      durationMs: String(durationMs),
    });
  } catch (error) {
    logger.error('Engagement trend refresh failed', {
      error: String(error),
      durationMs: String(Date.now() - startTime),
    });
  }
}

app.timer('engagement-trend-refresh', {
  schedule: '0 0 */6 * * *', // Every 6 hours
  handler: trendRefreshTimerHandler,
});
