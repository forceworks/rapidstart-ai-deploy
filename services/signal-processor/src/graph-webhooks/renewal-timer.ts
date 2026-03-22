/**
 * Subscription Renewal Timer — runs every 12 hours to renew
 * Graph webhook subscriptions before they expire.
 */

import { app, type InvocationContext, type Timer } from '@azure/functions';
import { loadConfig } from '../shared/config.js';
import { createTokenProvider } from '../shared/credentials.js';
import { createLogger } from '../shared/logger.js';
import { createDataverseClient } from '../shared/dataverse-client.js';
import { createSubscriptionManager, type SubscriptionManager } from './subscription-manager.js';

let manager: SubscriptionManager | null = null;

export async function renewalTimerHandler(timer: Timer, context: InvocationContext): Promise<void> {
  if (!manager) {
    const config = loadConfig();
    const tokenProvider = createTokenProvider(config.credentials);
    const logger = createLogger(config.logging.appInsightsConnectionString);
    const dataverseClient = createDataverseClient(
      config.dataverse.toolBaseUrl,
      tokenProvider,
      config.dataverse.url,
      logger
    );
    manager = createSubscriptionManager(tokenProvider, dataverseClient, logger);
  }

  const config = loadConfig();
  const logger = createLogger(config.logging.appInsightsConnectionString);

  logger.info('Subscription renewal timer fired', {
    scheduledTime: timer.scheduleStatus?.last || 'unknown',
  });

  try {
    const subscriptions = await manager.listActiveSubscriptions();

    logger.info('Active subscriptions found', {
      count: String(subscriptions.length),
    });

    let renewed = 0;
    let failed = 0;

    for (const sub of subscriptions) {
      try {
        await manager.renewSubscription(sub.fw_subscriptionid);
        renewed++;
      } catch (error) {
        failed++;
        logger.error('Failed to renew subscription', {
          subscriptionId: sub.fw_subscriptionid,
          error: String(error),
        });
      }
    }

    logger.info('Subscription renewal complete', {
      total: String(subscriptions.length),
      renewed: String(renewed),
      failed: String(failed),
    });
  } catch (error) {
    logger.error('Subscription renewal timer failed', {
      error: String(error),
    });
    throw error;
  }
}

app.timer('subscription-renewal', {
  schedule: '0 0 */12 * * *', // Every 12 hours
  handler: renewalTimerHandler,
});
