/**
 * Next-Step Recommendation Engine — analyzes meeting context and opportunity
 * state to suggest concrete next actions for salespeople.
 *
 * Recommendations are rule-based (no AI call needed) with optional AI
 * enrichment for more specific suggestions.
 *
 * Recommendation types:
 *   - follow-up-email: Send a follow-up email
 *   - schedule-meeting: Schedule a follow-up meeting
 *   - add-contact: Add a new stakeholder as a CRM contact
 *   - create-task: Create a task from an action item
 *   - update-stage: Consider advancing the opportunity stage
 *   - escalate: Involve management or additional resources
 */

import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';
import {
  type MeetingSummary,
  type StakeholderDetectionResult,
  type EngagementScore,
} from '../shared/types.js';

export interface NextStepRecommenderService {
  /** Generate recommendations based on meeting and opportunity context */
  recommend(context: RecommendationContext): Promise<Recommendation[]>;
}

export interface RecommendationContext {
  opportunityId: string;
  opportunityName: string;
  opportunityStage?: string;
  accountId?: string;
  meetingSummary?: MeetingSummary;
  stakeholders?: StakeholderDetectionResult;
  engagementScore?: EngagementScore;
  activityId?: string;
  signalId: string;
}

export interface Recommendation {
  type: RecommendationType;
  priority: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  /** Data payload for executing the recommendation */
  actionData: Record<string, string>;
}

export type RecommendationType =
  | 'follow-up-email'
  | 'schedule-meeting'
  | 'add-contact'
  | 'create-task'
  | 'update-stage'
  | 'escalate';

/** Stages ordered by progression */
const STAGE_ORDER: Record<string, number> = {
  qualify: 1,
  develop: 2,
  propose: 3,
  close: 4,
};

export function createNextStepRecommender(
  dataverseClient: DataverseClient,
  logger: Logger
): NextStepRecommenderService {
  return {
    async recommend(context: RecommendationContext): Promise<Recommendation[]> {
      const startTime = Date.now();
      const recommendations: Recommendation[] = [];

      const { meetingSummary, stakeholders, engagementScore, opportunityStage } = context;

      // Rule 1: Always recommend follow-up email after a meeting
      if (meetingSummary) {
        recommendations.push({
          type: 'follow-up-email',
          priority: 'high',
          title: 'Send follow-up email',
          description: `Send a follow-up email summarizing the meeting on "${context.opportunityName}" and confirming next steps.`,
          actionData: {
            opportunityId: context.opportunityId,
            activityId: context.activityId || '',
            signalId: context.signalId,
          },
        });
      }

      // Rule 2: Create tasks from action items
      if (meetingSummary?.actionItems && meetingSummary.actionItems.length > 0) {
        for (const item of meetingSummary.actionItems) {
          recommendations.push({
            type: 'create-task',
            priority: item.dueDate ? 'high' : 'medium',
            title: `Create task: ${truncate(item.description, 60)}`,
            description: item.assignee
              ? `Assigned to ${item.assignee}${item.dueDate ? `, due ${item.dueDate}` : ''}`
              : `From meeting action items${item.dueDate ? `, due ${item.dueDate}` : ''}`,
            actionData: {
              description: item.description,
              assignee: item.assignee || '',
              dueDate: item.dueDate || '',
              opportunityId: context.opportunityId,
              signalId: context.signalId,
            },
          });
        }
      }

      // Rule 3: Add unknown stakeholders as contacts
      if (stakeholders?.unknownStakeholders) {
        for (const stakeholder of stakeholders.unknownStakeholders) {
          if (stakeholder.suggestedAccountId && stakeholder.occurrenceCount >= 2) {
            recommendations.push({
              type: 'add-contact',
              priority: stakeholder.occurrenceCount >= 3 ? 'high' : 'medium',
              title: `Add ${stakeholder.displayName || stakeholder.email} as contact`,
              description: `Appeared in ${stakeholder.occurrenceCount} meetings with ${stakeholder.suggestedAccountName || 'this account'}. Not yet in CRM.`,
              actionData: {
                email: stakeholder.email,
                displayName: stakeholder.displayName || '',
                accountId: stakeholder.suggestedAccountId,
                accountName: stakeholder.suggestedAccountName || '',
              },
            });
          }
        }
      }

      // Rule 4: Schedule follow-up meeting if next steps mention it
      if (meetingSummary?.nextSteps) {
        const meetingKeywords = ['meeting', 'call', 'demo', 'presentation', 'review', 'session'];
        const suggestsMeeting = meetingSummary.nextSteps.some(
          (step) => meetingKeywords.some((kw) => step.toLowerCase().includes(kw))
        );

        if (suggestsMeeting) {
          recommendations.push({
            type: 'schedule-meeting',
            priority: 'medium',
            title: 'Schedule follow-up meeting',
            description: `Next steps suggest a follow-up meeting. Consider scheduling within the next week.`,
            actionData: {
              opportunityId: context.opportunityId,
              suggestedNextSteps: meetingSummary.nextSteps.join('; '),
            },
          });
        }
      }

      // Rule 5: Consider stage advancement after positive meetings
      if (meetingSummary?.sentiment === 'positive' && opportunityStage) {
        const currentOrder = STAGE_ORDER[opportunityStage.toLowerCase()] || 0;
        if (currentOrder > 0 && currentOrder < 4) {
          const nextStage = Object.entries(STAGE_ORDER).find(
            ([, order]) => order === currentOrder + 1
          );

          if (nextStage) {
            recommendations.push({
              type: 'update-stage',
              priority: 'low',
              title: `Consider advancing to ${nextStage[0]} stage`,
              description: `Meeting had positive sentiment. Evaluate if the opportunity is ready to move from ${opportunityStage} to ${nextStage[0]}.`,
              actionData: {
                opportunityId: context.opportunityId,
                currentStage: opportunityStage,
                suggestedStage: nextStage[0],
              },
            });
          }
        }
      }

      // Rule 6: Escalation for negative sentiment or declining engagement
      if (meetingSummary?.sentiment === 'negative') {
        recommendations.push({
          type: 'escalate',
          priority: 'high',
          title: 'Review negative meeting sentiment',
          description: 'Recent meeting had negative sentiment. Consider involving management or additional resources to address concerns.',
          actionData: {
            opportunityId: context.opportunityId,
            reason: 'negative-sentiment',
            activityId: context.activityId || '',
          },
        });
      }

      if (engagementScore && engagementScore.trend === 'inactive') {
        recommendations.push({
          type: 'escalate',
          priority: 'high',
          title: 'Re-engage inactive opportunity',
          description: `No activity for ${engagementScore.daysSinceLastSignal} days. Consider a re-engagement strategy or involve management.`,
          actionData: {
            opportunityId: context.opportunityId,
            reason: 'inactive-engagement',
            daysSinceLastSignal: String(engagementScore.daysSinceLastSignal),
          },
        });
      }

      // Sort by priority
      const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
      recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

      const durationMs = Date.now() - startTime;
      logger.info('Next-step recommendations generated', {
        opportunityId: context.opportunityId,
        count: String(recommendations.length),
        types: [...new Set(recommendations.map((r) => r.type))].join(', '),
        durationMs: String(durationMs),
      });

      return recommendations;
    },
  };
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}
