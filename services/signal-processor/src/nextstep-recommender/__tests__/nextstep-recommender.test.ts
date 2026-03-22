import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNextStepRecommender } from '../index.js';
import { type DataverseClient } from '../../shared/dataverse-client.js';
import { type Logger } from '../../shared/logger.js';
import { type MeetingSummary, type StakeholderDetectionResult, type EngagementScore } from '../../shared/types.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trackSignal: vi.fn(),
    trackDependency: vi.fn(),
  };
}

function createMockClient(): DataverseClient {
  return {
    get: vi.fn().mockResolvedValue([]),
    getById: vi.fn(),
    executeAction: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
}

describe('createNextStepRecommender', () => {
  let mockLogger: Logger;
  let mockClient: DataverseClient;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockClient = createMockClient();
  });

  it('recommends follow-up email when meeting summary is present', async () => {
    const recommender = createNextStepRecommender(mockClient, mockLogger);
    const summary: MeetingSummary = {
      summary: 'Discussed next steps.',
      keyDecisions: [],
      actionItems: [],
      nextSteps: [],
      sentiment: 'neutral',
      topics: [],
    };

    const recs = await recommender.recommend({
      opportunityId: 'opp-1',
      opportunityName: 'Big Deal',
      meetingSummary: summary,
      signalId: 'sig-1',
    });

    const emailRec = recs.find((r) => r.type === 'follow-up-email');
    expect(emailRec).toBeDefined();
    expect(emailRec!.priority).toBe('high');
  });

  it('creates task recommendations from action items', async () => {
    const recommender = createNextStepRecommender(mockClient, mockLogger);
    const summary: MeetingSummary = {
      summary: 'Discussed tasks.',
      keyDecisions: [],
      actionItems: [
        { description: 'Send proposal', assignee: 'John', dueDate: '2026-04-01' },
        { description: 'Review pricing' },
      ],
      nextSteps: [],
      sentiment: 'neutral',
      topics: [],
    };

    const recs = await recommender.recommend({
      opportunityId: 'opp-1',
      opportunityName: 'Deal',
      meetingSummary: summary,
      signalId: 'sig-1',
    });

    const taskRecs = recs.filter((r) => r.type === 'create-task');
    expect(taskRecs).toHaveLength(2);
    // Task with due date should be high priority
    expect(taskRecs[0].priority).toBe('high');
    expect(taskRecs[1].priority).toBe('medium');
  });

  it('recommends adding contacts for recurring unknown stakeholders', async () => {
    const recommender = createNextStepRecommender(mockClient, mockLogger);
    const stakeholders: StakeholderDetectionResult = {
      knownContacts: [],
      unknownStakeholders: [
        {
          email: 'new@contoso.com',
          displayName: 'New Person',
          domain: 'contoso.com',
          suggestedAccountId: 'acc-1',
          suggestedAccountName: 'Contoso',
          occurrenceCount: 3,
        },
      ],
      newStakeholderInKnownAccount: true,
    };

    const recs = await recommender.recommend({
      opportunityId: 'opp-1',
      opportunityName: 'Deal',
      stakeholders,
      signalId: 'sig-1',
    });

    const addContact = recs.find((r) => r.type === 'add-contact');
    expect(addContact).toBeDefined();
    expect(addContact!.title).toContain('New Person');
    expect(addContact!.priority).toBe('high');
  });

  it('recommends scheduling meeting when next steps mention it', async () => {
    const recommender = createNextStepRecommender(mockClient, mockLogger);
    const summary: MeetingSummary = {
      summary: 'Good progress.',
      keyDecisions: [],
      actionItems: [],
      nextSteps: ['Schedule a demo with the engineering team'],
      sentiment: 'positive',
      topics: [],
    };

    const recs = await recommender.recommend({
      opportunityId: 'opp-1',
      opportunityName: 'Deal',
      meetingSummary: summary,
      signalId: 'sig-1',
    });

    const meetingRec = recs.find((r) => r.type === 'schedule-meeting');
    expect(meetingRec).toBeDefined();
  });

  it('recommends stage advancement on positive sentiment', async () => {
    const recommender = createNextStepRecommender(mockClient, mockLogger);
    const summary: MeetingSummary = {
      summary: 'Very positive meeting.',
      keyDecisions: ['Verbal agreement to proceed'],
      actionItems: [],
      nextSteps: [],
      sentiment: 'positive',
      topics: [],
    };

    const recs = await recommender.recommend({
      opportunityId: 'opp-1',
      opportunityName: 'Deal',
      opportunityStage: 'Develop',
      meetingSummary: summary,
      signalId: 'sig-1',
    });

    const stageRec = recs.find((r) => r.type === 'update-stage');
    expect(stageRec).toBeDefined();
    expect(stageRec!.actionData.suggestedStage).toBe('propose');
  });

  it('recommends escalation for negative sentiment', async () => {
    const recommender = createNextStepRecommender(mockClient, mockLogger);
    const summary: MeetingSummary = {
      summary: 'Customer expressed frustration.',
      keyDecisions: [],
      actionItems: [],
      nextSteps: [],
      sentiment: 'negative',
      topics: [],
    };

    const recs = await recommender.recommend({
      opportunityId: 'opp-1',
      opportunityName: 'Deal',
      meetingSummary: summary,
      signalId: 'sig-1',
    });

    const escalation = recs.find((r) => r.type === 'escalate');
    expect(escalation).toBeDefined();
    expect(escalation!.priority).toBe('high');
  });

  it('recommends escalation for inactive engagement', async () => {
    const recommender = createNextStepRecommender(mockClient, mockLogger);
    const engagement: EngagementScore = {
      entityType: 'opportunity',
      entityId: 'opp-1',
      entityName: 'Stale Deal',
      score: 0.05,
      recencyScore: 0.02,
      frequencyScore: 0.1,
      signalCount: 1,
      lastSignalDate: '2025-01-01',
      daysSinceLastSignal: 90,
      trend: 'inactive',
    };

    const recs = await recommender.recommend({
      opportunityId: 'opp-1',
      opportunityName: 'Stale Deal',
      engagementScore: engagement,
      signalId: 'sig-1',
    });

    const escalation = recs.find((r) => r.type === 'escalate' && r.actionData.reason === 'inactive-engagement');
    expect(escalation).toBeDefined();
    expect(escalation!.description).toContain('90 days');
  });

  it('returns recommendations sorted by priority', async () => {
    const recommender = createNextStepRecommender(mockClient, mockLogger);
    const summary: MeetingSummary = {
      summary: 'Negative meeting.',
      keyDecisions: [],
      actionItems: [{ description: 'Send report' }],
      nextSteps: ['Schedule follow-up call'],
      sentiment: 'negative',
      topics: [],
    };

    const recs = await recommender.recommend({
      opportunityId: 'opp-1',
      opportunityName: 'Deal',
      meetingSummary: summary,
      signalId: 'sig-1',
    });

    // High priority items should come first
    const priorities = recs.map((r) => r.priority);
    const highIndex = priorities.indexOf('high');
    const medIndex = priorities.indexOf('medium');
    if (highIndex >= 0 && medIndex >= 0) {
      expect(highIndex).toBeLessThan(medIndex);
    }
  });
});
