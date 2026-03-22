/**
 * Signal Processor — Service Bus triggered pipeline.
 * Orchestrates: Entity Match → Confidence Score → Route (Tool Dispatch or Review Queue).
 *
 * Phase 2 additions:
 *   - AI Summarization after successful tool dispatch (graceful degradation)
 *   - Stakeholder detection on every signal
 *   - Engagement scoring after processing
 *
 * Phase 4 additions:
 *   - Task auto-generation from detected action items
 *   - Next-step recommendations persisted as suggestions
 *   - Follow-up email draft generation (on-demand, triggered via suggestions)
 *
 * Reads signals from the Service Bus queue dispatched by the Signal Router.
 * Graceful degradation: if AI fails, log without summary, never drop signal.
 */

import { app, type InvocationContext } from '@azure/functions';
import { type Signal } from '../shared/types.js';
import { initializeServices, type ServiceContainer } from './container.js';

let services: ServiceContainer | null = null;

export async function signalProcessorHandler(
  message: unknown,
  context: InvocationContext
): Promise<void> {
  if (!services) {
    services = initializeServices();
  }

  const {
    entityMatcher, confidenceScorer, toolDispatcher,
    reviewQueueManager, signalLogService, logger,
    aiSummarizer, stakeholderDetector, engagementScorer,
    taskGenerator, nextStepRecommender,
  } = services;

  const startTime = Date.now();

  // Parse the signal from the Service Bus message
  const signal = message as Signal;

  if (!signal?.id || !signal?.graphResourceId) {
    logger.error('Invalid signal message received', { message: JSON.stringify(message) });
    // Don't throw — this would retry forever. Let it complete (effectively dead-letter via max delivery count).
    return;
  }

  logger.info('Processing signal', {
    signalId: signal.id,
    graphResourceId: signal.graphResourceId,
    signalType: signal.signalType,
    subject: signal.subject,
  });

  try {
    // Update signal log to 'processing'
    await signalLogService.updateStatus(signal.id, 'processing');

    // Step 1: Entity matching
    const matches = await entityMatcher.matchEntities(signal);

    // Step 2: Confidence scoring
    const confidenceResult = confidenceScorer.score(matches);

    // Step 3: Stakeholder detection (Phase 2 — runs on every signal)
    let stakeholderResult;
    try {
      stakeholderResult = await stakeholderDetector.detect(signal, confidenceResult);

      if (stakeholderResult.newStakeholderInKnownAccount) {
        logger.info('New stakeholder detected in known account', {
          signalId: signal.id,
          unknownCount: String(stakeholderResult.unknownStakeholders.length),
          stakeholders: stakeholderResult.unknownStakeholders
            .filter((s) => s.suggestedAccountId)
            .map((s) => `${s.email} → ${s.suggestedAccountName}`)
            .join(', '),
        });
      }
    } catch (error) {
      // Graceful degradation — stakeholder detection is non-critical
      logger.warn('Stakeholder detection failed (non-fatal)', {
        signalId: signal.id,
        error: String(error),
      });
    }

    const durationMs = Date.now() - startTime;

    // Step 4: Route based on confidence
    if (confidenceResult.requiresReview) {
      // Below threshold → review queue
      const reviewId = await reviewQueueManager.enqueue(signal, confidenceResult);

      await signalLogService.updateStatus(signal.id, 'queued-for-review');

      logger.info('Signal routed to review queue', {
        signalId: signal.id,
        confidence: String(confidenceResult.overallConfidence),
        reviewId,
        reason: confidenceResult.reviewReason || '',
        durationMs: String(durationMs),
      });
    } else {
      // Above threshold → auto-process via tool dispatcher
      const result = await toolDispatcher.logMeeting(signal, confidenceResult);

      if (result.success) {
        await signalLogService.updateStatus(signal.id, 'processed');

        logger.info('Signal auto-processed', {
          signalId: signal.id,
          activityId: result.activityid,
          confidence: String(confidenceResult.overallConfidence),
          durationMs: String(durationMs),
        });

        // Step 5: AI Summarization (Phase 2 — graceful degradation)
        // Only for meeting signals with a successfully created activity
        let summaryResult: import('../shared/types.js').SummarizationResult | undefined;
        if (signal.signalType === 'meeting' && result.activityid) {
          try {
            summaryResult = await aiSummarizer.summarize(signal);

            if (summaryResult.success && summaryResult.meetingSummary) {
              // Dispatch meeting notes to CRM
              const notesResult = await toolDispatcher.addMeetingNotes(
                result.activityid,
                summaryResult.meetingSummary,
                signal.id
              );

              if (notesResult.success) {
                logger.info('AI meeting notes added', {
                  signalId: signal.id,
                  activityId: result.activityid,
                  tokensUsed: String(summaryResult.tokensUsed),
                  sentiment: summaryResult.meetingSummary.sentiment,
                });
              } else {
                logger.warn('Failed to add meeting notes to CRM', {
                  signalId: signal.id,
                  message: notesResult.message,
                });
              }
            } else {
              logger.info('AI summarization did not produce results', {
                signalId: signal.id,
                reason: summaryResult.errorMessage || 'unknown',
              });
            }
          } catch (error) {
            // Graceful degradation — AI is non-critical
            logger.warn('AI summarization pipeline failed (non-fatal)', {
              signalId: signal.id,
              error: String(error),
            });
          }
        }

        // Step 6: Task auto-generation from action items (Phase 4 — best effort)
        if (signal.signalType === 'meeting' && result.activityid && summaryResult?.success && summaryResult.meetingSummary) {
          try {
            const taskResult = await taskGenerator.generateTasks({
              meetingSummary: summaryResult.meetingSummary,
              opportunityId: confidenceResult.accountMatch?.entityId || '',
              opportunityName: signal.subject,
              accountId: confidenceResult.accountMatch?.entityId,
              activityId: result.activityid,
              signalId: signal.id,
              ownerUserId: signal.userId,
            });

            if (taskResult.tasksCreated > 0) {
              logger.info('Tasks auto-generated from action items', {
                signalId: signal.id,
                created: String(taskResult.tasksCreated),
                total: String(taskResult.totalActionItems),
              });
            }
          } catch (error) {
            logger.warn('Task generation failed (non-fatal)', {
              signalId: signal.id,
              error: String(error),
            });
          }
        }

        // Step 7: Next-step recommendations (Phase 4 — best effort)
        if (result.activityid) {
          try {
            const recommendations = await nextStepRecommender.recommend({
              opportunityId: confidenceResult.accountMatch?.entityId || '',
              opportunityName: signal.subject,
              opportunityStage: undefined, // Would need opp lookup; keep lightweight
              accountId: confidenceResult.accountMatch?.entityId,
              meetingSummary: summaryResult?.meetingSummary,
              stakeholders: stakeholderResult,
              activityId: result.activityid,
              signalId: signal.id,
            });

            // Persist top recommendations as suggestions
            for (const rec of recommendations.slice(0, 5)) {
              try {
                await toolDispatcher.suggestFollowUp(
                  confidenceResult.accountMatch?.entityId || '',
                  rec,
                  signal.id
                );
              } catch (error) {
                logger.warn('Failed to persist suggestion', {
                  signalId: signal.id,
                  type: rec.type,
                  error: String(error),
                });
              }
            }
          } catch (error) {
            logger.warn('Next-step recommendations failed (non-fatal)', {
              signalId: signal.id,
              error: String(error),
            });
          }
        }

        // Step 8: Engagement scoring (Phase 2 — best effort)
        if (confidenceResult.accountMatch) {
          try {
            const engScore = await engagementScorer.scoreAccount(
              confidenceResult.accountMatch.entityId
            );
            await engagementScorer.persistScore(engScore);
          } catch (error) {
            logger.warn('Engagement scoring failed (non-fatal)', {
              signalId: signal.id,
              accountId: confidenceResult.accountMatch.entityId,
              error: String(error),
            });
          }
        }
      } else {
        // Tool dispatch returned failure — queue for review
        logger.warn('Tool dispatch failed, routing to review', {
          signalId: signal.id,
          message: result.message,
        });

        await reviewQueueManager.enqueue(signal, confidenceResult);
        await signalLogService.updateStatus(signal.id, 'queued-for-review', result.message);
      }
    }
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Signal processing failed', {
      signalId: signal.id,
      error: errorMessage,
      durationMs: String(durationMs),
    });

    // Update signal log with failure
    try {
      await signalLogService.updateStatus(signal.id, 'failed', errorMessage);
    } catch (logError) {
      logger.error('Failed to update signal log after error', {
        signalId: signal.id,
        logError: String(logError),
      });
    }

    // Re-throw so Service Bus can retry (up to max delivery count, then DLQ)
    throw error;
  }
}

app.serviceBusQueue('signal-processor', {
  queueName: '%SERVICE_BUS_SIGNAL_QUEUE_NAME%',
  connection: 'SERVICE_BUS_CONNECTION_STRING',
  handler: signalProcessorHandler,
});
