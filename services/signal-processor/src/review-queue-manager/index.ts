/**
 * Review Queue Manager — creates and manages fw_reviewqueue records
 * for signals that fall below the confidence threshold.
 */

import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';
import { type Signal, type ConfidenceResult, type ReviewQueueItem } from '../shared/types.js';

export interface ReviewQueueService {
  /** Enqueue a signal for human review */
  enqueue(signal: Signal, confidenceResult: ConfidenceResult): Promise<string>;
  /** Attach execution suggestions to a review queue item */
  attachSuggestions(reviewQueueId: string, suggestions: ReviewSuggestion[]): Promise<void>;
}

export interface ReviewSuggestion {
  type: string;
  title: string;
  description: string;
  priority: string;
}

const REVIEW_STATUS_MAP: Record<string, number> = {
  pending: 1,
  approved: 2,
  dismissed: 3,
};

export function createReviewQueueManager(
  dataverseClient: DataverseClient,
  logger: Logger
): ReviewQueueService {
  return {
    async enqueue(signal: Signal, confidenceResult: ConfidenceResult): Promise<string> {
      const record: Record<string, unknown> = {
        fw_signalid: signal.id,
        fw_graphresourceid: signal.graphResourceId,
        fw_signaltype: signal.signalType === 'meeting' ? 1 : signal.signalType === 'email' ? 2 : 3,
        fw_subject: signal.subject,
        fw_useremail: signal.userEmail,
        fw_participantemails: signal.participants.map((p) => p.email).join(';'),
        fw_meetingstart: signal.startTime,
        fw_confidencescore: confidenceResult.overallConfidence,
        fw_reviewreason: confidenceResult.reviewReason || 'Unknown',
        fw_status: REVIEW_STATUS_MAP['pending'],
        fw_signalpayload: JSON.stringify(signal),
        fw_entitymatches: JSON.stringify(confidenceResult),
      };

      // Link to best account match if available (even though it's below threshold)
      if (confidenceResult.accountMatch) {
        record['fw_suggestedaccountid@odata.bind'] =
          `/accounts(${confidenceResult.accountMatch.entityId})`;
      }

      const id = await dataverseClient.create('fw_reviewqueues', record);

      logger.trackSignal(signal.id, 'queued-for-review', {
        reviewQueueId: id,
        confidence: String(confidenceResult.overallConfidence),
        reason: confidenceResult.reviewReason || '',
      });

      return id;
    },

    async attachSuggestions(reviewQueueId: string, suggestions: ReviewSuggestion[]): Promise<void> {
      if (suggestions.length === 0) return;

      try {
        await dataverseClient.update('fw_reviewqueues', reviewQueueId, {
          fw_suggestedactions: JSON.stringify(suggestions),
        });

        logger.info('Execution suggestions attached to review queue item', {
          reviewQueueId,
          suggestionCount: String(suggestions.length),
        });
      } catch (error) {
        logger.warn('Failed to attach suggestions to review queue item', {
          reviewQueueId,
          error: String(error),
        });
      }
    },
  };
}
