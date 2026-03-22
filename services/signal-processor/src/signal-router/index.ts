/**
 * Signal Router — Azure Function HTTP trigger.
 * Entry point for all Graph webhook notifications.
 *
 * Responsibilities:
 * 1. Handle Graph validation requests (return validationToken)
 * 2. Parse change notification batch
 * 3. For each notification: idempotency check → fetch event → dispatch to queue
 * 4. Return 202 Accepted quickly (Graph requires fast responses)
 */

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { loadConfig } from '../shared/config.js';
import { createTokenProvider } from '../shared/credentials.js';
import { createLogger } from '../shared/logger.js';
import { createDataverseClient } from '../shared/dataverse-client.js';
import { createQueueClient } from '../shared/queue-client.js';
import { createUsageGovernanceService } from '../shared/usage-governance.js';
import { parseChangeNotifications, extractResourceIds } from './graph-parser.js';
import { createGraphEventFetcher } from './graph-fetcher.js';
import { createSignalLogService } from './signal-log.js';

// Lazy-initialized singletons
let initialized = false;
let graphFetcher: ReturnType<typeof createGraphEventFetcher>;
let signalLog: ReturnType<typeof createSignalLogService>;
let queueClient: ReturnType<typeof createQueueClient>;
let usageGovernance: ReturnType<typeof createUsageGovernanceService>;
let logger: ReturnType<typeof createLogger>;

function initialize(): void {
  if (initialized) return;

  const config = loadConfig();
  logger = createLogger(config.logging.appInsightsConnectionString);
  const tokenProvider = createTokenProvider(config.credentials);
  const dataverseClient = createDataverseClient(
    config.dataverse.toolBaseUrl,
    tokenProvider,
    config.dataverse.url,
    logger
  );

  graphFetcher = createGraphEventFetcher(tokenProvider, logger);
  signalLog = createSignalLogService(dataverseClient, logger);
  queueClient = createQueueClient(
    config.serviceBus.connectionString,
    config.serviceBus.signalQueueName,
    config.serviceBus.deadLetterQueueName,
    logger
  );
  usageGovernance = createUsageGovernanceService(dataverseClient, config.governance, logger);

  initialized = true;
}

export async function signalRouterHandler(
  request: HttpRequest,
  _context: InvocationContext
): Promise<HttpResponseInit> {
  // Step 1: Handle Graph validation request
  const validationToken = request.query.get('validationToken');
  if (validationToken) {
    return {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: validationToken,
    };
  }

  initialize();

  // Step 2: Parse the notification payload
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logger.warn('Failed to parse request body as JSON');
    return { status: 400, body: 'Invalid JSON body' };
  }

  let notifications;
  try {
    notifications = parseChangeNotifications(body);
  } catch (error) {
    logger.warn('Failed to parse change notifications', {
      error: (error as Error).message,
    });
    return { status: 400, body: `Invalid notification format: ${(error as Error).message}` };
  }

  if (notifications.length === 0) {
    return { status: 202, body: 'No actionable notifications' };
  }

  // Step 3: Process each notification (best-effort, don't fail the batch)
  const results: Array<{ graphResourceId: string; status: string }> = [];

  for (const notification of notifications) {
    try {
      const { userId, eventId } = extractResourceIds(notification.resource);
      const graphResourceId = notification.resourceData.id;

      // Idempotency check
      const alreadyExists = await signalLog.exists(graphResourceId);
      if (alreadyExists) {
        logger.info('Signal already processed, skipping', { graphResourceId });
        results.push({ graphResourceId, status: 'skipped-duplicate' });
        continue;
      }

      // Usage governance check
      const usageCheck = await usageGovernance.checkUsage(notification.tenantId, userId);
      if (!usageCheck.allowed) {
        // Log but don't drop — create signal log entry with governance-denied status
        await signalLog.create({
          signalId: `gov-denied-${graphResourceId}`,
          graphResourceId,
          signalType: 'meeting',
          status: 'governance-denied',
          confidence: 0,
          processingDurationMs: 0,
          userEmail: '',
          createdAt: new Date().toISOString(),
        });
        logger.trackSignal(`gov-denied-${graphResourceId}`, 'governance-denied', {
          reason: usageCheck.reason || 'limit-reached',
        });
        results.push({ graphResourceId, status: 'governance-denied' });
        continue;
      }

      // Fetch full event from Graph
      const signal = await graphFetcher.getCalendarEvent(userId, eventId);
      signal.tenantId = notification.tenantId;

      // Log as received
      await signalLog.create({
        signalId: signal.id,
        graphResourceId: signal.graphResourceId,
        signalType: signal.signalType,
        status: 'received',
        confidence: 0,
        processingDurationMs: 0,
        userEmail: signal.userEmail,
        signalPayload: JSON.stringify(signal),
        createdAt: new Date().toISOString(),
      });

      // Dispatch to Service Bus queue
      await queueClient.sendSignal(signal);

      results.push({ graphResourceId, status: 'dispatched' });
    } catch (error) {
      logger.error('Failed to process notification', {
        resource: notification.resource,
        error: String(error),
      });
      results.push({
        graphResourceId: notification.resourceData.id,
        status: 'error',
      });
    }
  }

  // Step 4: Return 202 quickly
  return {
    status: 202,
    jsonBody: {
      processed: results.length,
      results,
    },
  };
}

app.http('signal-router', {
  methods: ['POST'],
  authLevel: 'function',
  handler: signalRouterHandler,
});
