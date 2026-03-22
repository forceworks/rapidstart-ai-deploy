/**
 * Dead-Letter Handler — Service Bus trigger on the DLQ.
 * Logs failures and optionally re-enqueues if delivery count < 3.
 */

import { app, type InvocationContext } from '@azure/functions';
import { loadConfig } from '../shared/config.js';
import { createTokenProvider } from '../shared/credentials.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { createDataverseClient } from '../shared/dataverse-client.js';
import { createQueueClient, type QueueClient } from '../shared/queue-client.js';
import { createSignalLogService, type SignalLogService } from '../signal-router/signal-log.js';
import { type Signal } from '../shared/types.js';

const MAX_REQUEUE_ATTEMPTS = 3;

let logger: Logger | null = null;
let queueClient: QueueClient | null = null;
let signalLogService: SignalLogService | null = null;

function ensureInitialized(): void {
  if (logger) return;
  const config = loadConfig();
  const tokenProvider = createTokenProvider(config.credentials);
  logger = createLogger(config.logging.appInsightsConnectionString);
  const dataverseClient = createDataverseClient(
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
  signalLogService = createSignalLogService(dataverseClient, logger);
}

export async function deadLetterHandler(
  message: unknown,
  context: InvocationContext
): Promise<void> {
  ensureInitialized();

  const signal = message as Signal;
  const deliveryCount = (context as unknown as Record<string, unknown>).deliveryCount as number || 0;

  if (!signal?.id) {
    logger!.error('Invalid dead-letter message', { message: JSON.stringify(message) });
    return;
  }

  logger!.warn('Dead-letter received', {
    signalId: signal.id,
    graphResourceId: signal.graphResourceId || 'unknown',
    deliveryCount: String(deliveryCount),
  });

  try {
    // Update signal log
    await signalLogService!.updateStatus(signal.id, 'dead-lettered', `Dead-lettered after ${deliveryCount} attempts`);

    // Attempt re-enqueue if under max retries
    if (deliveryCount < MAX_REQUEUE_ATTEMPTS) {
      logger!.info('Re-enqueuing dead-lettered signal', {
        signalId: signal.id,
        attempt: String(deliveryCount + 1),
        maxAttempts: String(MAX_REQUEUE_ATTEMPTS),
      });

      await queueClient!.sendSignal(signal);

      await signalLogService!.updateStatus(
        signal.id,
        'received',
        `Re-enqueued from DLQ (attempt ${deliveryCount + 1})`
      );
    } else {
      logger!.error('Signal permanently dead-lettered (max retries exceeded)', {
        signalId: signal.id,
        graphResourceId: signal.graphResourceId || 'unknown',
        subject: signal.subject || 'unknown',
      });
    }
  } catch (error) {
    logger!.error('Dead-letter handler failed', {
      signalId: signal.id,
      error: String(error),
    });
    // Don't re-throw — we don't want the DLQ handler to also dead-letter
  }
}

app.serviceBusQueue('dead-letter-handler', {
  queueName: '%SERVICE_BUS_DEAD_LETTER_QUEUE_NAME%',
  connection: 'SERVICE_BUS_CONNECTION_STRING',
  handler: deadLetterHandler,
});
