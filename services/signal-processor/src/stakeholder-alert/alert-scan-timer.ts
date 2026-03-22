/**
 * Stakeholder Alert Scan Timer — runs daily to detect new stakeholder patterns
 * and generate alerts for salespeople.
 *
 * Schedule: Every day at 7:00 AM UTC (1 hour after gap scan)
 *
 * Flow:
 *   1. Scan stakeholder occurrences for recurring unknowns
 *   2. Generate alerts for accounts with new stakeholder patterns
 *   3. Persist alerts for dashboard consumption
 */

import { app, type InvocationContext } from '@azure/functions';
import { loadConfig } from '../shared/config.js';
import { createTokenProvider } from '../shared/credentials.js';
import { createLogger } from '../shared/logger.js';
import { createDataverseClient } from '../shared/dataverse-client.js';
import { createStakeholderAlertService } from './index.js';

export async function alertScanTimerHandler(
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

  const alertService = createStakeholderAlertService(dataverseClient, logger);

  logger.info('Daily stakeholder alert scan starting');

  const result = await alertService.scanAndAlert();

  logger.info('Daily stakeholder alert scan complete', {
    scanned: String(result.totalOccurrencesScanned),
    generated: String(result.alertsGenerated),
    persisted: String(result.alertsPersisted),
    durationMs: String(result.durationMs),
  });
}

app.timer('stakeholder-alert-scan', {
  schedule: '0 0 7 * * *', // Every day at 7:00 AM UTC
  handler: alertScanTimerHandler,
});
