/**
 * Delta Poll Timer — runs every 15 minutes to catch events
 * that may have been missed by webhook delivery.
 *
 * Uses Graph delta queries to get incremental changes since last poll.
 * Stores delta links in fw_aitenantconfig for each tracked user.
 */

import { app, type InvocationContext, type Timer } from '@azure/functions';
import { loadConfig } from '../shared/config.js';
import { createTokenProvider, type TokenProvider } from '../shared/credentials.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { createDataverseClient, type DataverseClient } from '../shared/dataverse-client.js';
import { getGraphToken } from '../shared/credentials.js';
import { createQueueClient, type QueueClient } from '../shared/queue-client.js';
import { createGraphEventFetcher } from '../signal-router/graph-fetcher.js';
import { type Signal } from '../shared/types.js';

interface DeltaResponse {
  value: Array<{
    id: string;
    subject?: string;
    '@removed'?: { reason: string };
    [key: string]: unknown;
  }>;
  '@odata.deltaLink'?: string;
  '@odata.nextLink'?: string;
}

interface DeltaTrackingRecord {
  fw_aitenantconfigid: string;
  fw_userid: string;
  fw_deltalink: string;
}

let initialized = false;
let tokenProvider: TokenProvider;
let dataverseClient: DataverseClient;
let logger: Logger;
let queueClient: QueueClient;

function ensureInitialized(): void {
  if (initialized) return;
  const config = loadConfig();
  tokenProvider = createTokenProvider(config.credentials);
  logger = createLogger(config.logging.appInsightsConnectionString);
  dataverseClient = createDataverseClient(
    config.dataverse.toolBaseUrl,
    tokenProvider,
    config.dataverse.url,
    logger
  );
  queueClient = createQueueClient(
    config.serviceBus.connectionString,
    config.serviceBus.signalQueueName,
    config.serviceBus.deadLetterQueueName,
    logger
  );
  initialized = true;
}

export async function deltaPollTimerHandler(timer: Timer, context: InvocationContext): Promise<void> {
  ensureInitialized();

  logger.info('Delta poll timer fired', {
    scheduledTime: timer.scheduleStatus?.last || 'unknown',
  });

  try {
    // Get users with active subscriptions (they have delta links stored)
    const trackingRecords = await dataverseClient.get<DeltaTrackingRecord>(
      'fw_aitenantconfigs',
      `$filter=fw_deltalink ne null&$select=fw_aitenantconfigid,fw_userid,fw_deltalink`
    );

    logger.info('Delta poll: tracking records found', {
      count: String(trackingRecords.length),
    });

    const fetcher = createGraphEventFetcher(tokenProvider, logger);
    let totalProcessed = 0;

    for (const record of trackingRecords) {
      try {
        const processed = await pollUserDelta(
          record.fw_userid,
          record.fw_deltalink,
          record.fw_aitenantconfigid,
          fetcher
        );
        totalProcessed += processed;
      } catch (error) {
        logger.error('Delta poll failed for user', {
          userId: record.fw_userid,
          error: String(error),
        });
      }
    }

    logger.info('Delta poll complete', {
      usersPolled: String(trackingRecords.length),
      eventsProcessed: String(totalProcessed),
    });
  } catch (error) {
    logger.error('Delta poll timer failed', { error: String(error) });
    throw error;
  }
}

async function pollUserDelta(
  userId: string,
  deltaLink: string,
  trackingRecordId: string,
  fetcher: ReturnType<typeof createGraphEventFetcher>
): Promise<number> {
  const token = await getGraphToken(tokenProvider);
  let url = deltaLink;
  let processedCount = 0;

  // Follow pagination
  while (url) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Graph delta query failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as DeltaResponse;

    // Process changed events (skip deleted)
    for (const event of data.value) {
      if (event['@removed']) continue;

      try {
        // Fetch full event details and dispatch to queue
        const signal = await fetcher.getCalendarEvent(userId, event.id);
        signal.tenantId = ''; // Will be enriched by the processor
        await queueClient.sendSignal(signal);
        processedCount++;
      } catch (error) {
        logger.warn('Delta poll: failed to process event', {
          userId,
          eventId: event.id,
          error: String(error),
        });
      }
    }

    // Save the delta link for next poll
    if (data['@odata.deltaLink']) {
      await dataverseClient.update('fw_aitenantconfigs', trackingRecordId, {
        fw_deltalink: data['@odata.deltaLink'],
      });
      url = ''; // Done
    } else if (data['@odata.nextLink']) {
      url = data['@odata.nextLink']; // More pages
    } else {
      url = ''; // No more data
    }
  }

  return processedCount;
}

app.timer('delta-poll', {
  schedule: '0 */15 * * * *', // Every 15 minutes
  handler: deltaPollTimerHandler,
});
