/**
 * Service Bus queue client wrapper.
 * Uses graphResourceId as messageId for built-in deduplication.
 */

import { ServiceBusClient, type ServiceBusSender } from '@azure/service-bus';
import { type Signal } from './types.js';
import { type Logger } from './logger.js';

export interface QueueClient {
  sendSignal(signal: Signal): Promise<void>;
  sendToDeadLetter(signal: Signal, reason: string): Promise<void>;
  close(): Promise<void>;
}

export function createQueueClient(
  connectionString: string,
  queueName: string,
  deadLetterQueueName: string,
  logger: Logger
): QueueClient {
  const sbClient = new ServiceBusClient(connectionString);
  let signalSender: ServiceBusSender | null = null;
  let dlqSender: ServiceBusSender | null = null;

  function getSignalSender(): ServiceBusSender {
    if (!signalSender) {
      signalSender = sbClient.createSender(queueName);
    }
    return signalSender;
  }

  function getDlqSender(): ServiceBusSender {
    if (!dlqSender) {
      dlqSender = sbClient.createSender(deadLetterQueueName);
    }
    return dlqSender;
  }

  return {
    async sendSignal(signal: Signal): Promise<void> {
      const sender = getSignalSender();
      const startTime = Date.now();

      await sender.sendMessages({
        body: signal,
        messageId: signal.graphResourceId, // deduplication key
        contentType: 'application/json',
        subject: signal.signalType,
        applicationProperties: {
          signalId: signal.id,
          signalType: signal.signalType,
          tenantId: signal.tenantId,
        },
      });

      logger.trackDependency('ServiceBus.Send', Date.now() - startTime, true, queueName);
      logger.trackSignal(signal.id, 'queued', { queueName });
    },

    async sendToDeadLetter(signal: Signal, reason: string): Promise<void> {
      const sender = getDlqSender();
      const startTime = Date.now();

      await sender.sendMessages({
        body: signal,
        messageId: `dlq-${signal.graphResourceId}`,
        contentType: 'application/json',
        subject: 'dead-letter',
        applicationProperties: {
          signalId: signal.id,
          reason,
          originalQueue: queueName,
        },
      });

      logger.trackDependency('ServiceBus.SendDLQ', Date.now() - startTime, true, deadLetterQueueName);
      logger.warn('Signal sent to dead-letter queue', {
        signalId: signal.id,
        reason,
      });
    },

    async close(): Promise<void> {
      if (signalSender) await signalSender.close();
      if (dlqSender) await dlqSender.close();
      await sbClient.close();
    },
  };
}
