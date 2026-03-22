import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTaskGenerator } from '../index.js';
import { type DataverseClient } from '../../shared/dataverse-client.js';
import { type Logger } from '../../shared/logger.js';
import { type MeetingSummary } from '../../shared/types.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trackSignal: vi.fn(),
    trackDependency: vi.fn(),
  };
}

describe('createTaskGenerator', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it('creates tasks from action items', async () => {
    const mockGet = vi.fn().mockResolvedValue([]); // no existing tasks
    const mockCreate = vi.fn()
      .mockResolvedValueOnce('task-1')
      .mockResolvedValueOnce('task-2');

    const client: DataverseClient = {
      get: mockGet,
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: mockCreate,
      update: vi.fn(),
    };

    const summary: MeetingSummary = {
      summary: 'Meeting summary.',
      keyDecisions: [],
      actionItems: [
        { description: 'Send proposal', assignee: 'John', dueDate: '2026-04-01' },
        { description: 'Review contract' },
      ],
      nextSteps: [],
      sentiment: 'neutral',
      topics: [],
    };

    const generator = createTaskGenerator(client, mockLogger);
    const result = await generator.generateTasks({
      meetingSummary: summary,
      opportunityId: 'opp-1',
      opportunityName: 'Big Deal',
      activityId: 'act-1',
      signalId: 'sig-1',
      ownerUserId: 'user-1',
    });

    expect(result.totalActionItems).toBe(2);
    expect(result.tasksCreated).toBe(2);
    expect(result.tasksSkipped).toBe(0);
    expect(result.tasksFailed).toBe(0);
    expect(result.tasks[0].taskId).toBe('task-1');
    expect(result.tasks[0].subject).toContain('Send proposal');
    expect(result.tasks[1].taskId).toBe('task-2');
  });

  it('skips tasks that already exist (idempotency)', async () => {
    const mockGet = vi.fn()
      // First task exists
      .mockResolvedValueOnce([{ activityid: 'existing-task', subject: '[AI] Send proposal' }])
      // Second task does not exist
      .mockResolvedValueOnce([]);
    const mockCreate = vi.fn().mockResolvedValue('task-new');

    const client: DataverseClient = {
      get: mockGet,
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: mockCreate,
      update: vi.fn(),
    };

    const summary: MeetingSummary = {
      summary: 'Meeting.',
      keyDecisions: [],
      actionItems: [
        { description: 'Send proposal' },
        { description: 'Review specs' },
      ],
      nextSteps: [],
      sentiment: 'neutral',
      topics: [],
    };

    const generator = createTaskGenerator(client, mockLogger);
    const result = await generator.generateTasks({
      meetingSummary: summary,
      opportunityId: 'opp-1',
      opportunityName: 'Deal',
      activityId: 'act-1',
      signalId: 'sig-1',
      ownerUserId: 'user-1',
    });

    expect(result.tasksCreated).toBe(1);
    expect(result.tasksSkipped).toBe(1);
    expect(result.tasks[0].status).toBe('skipped');
    expect(result.tasks[1].status).toBe('created');
  });

  it('handles creation failure gracefully', async () => {
    const mockGet = vi.fn().mockResolvedValue([]); // no existing
    const mockCreate = vi.fn().mockRejectedValue(new Error('Dataverse error'));

    const client: DataverseClient = {
      get: mockGet,
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: mockCreate,
      update: vi.fn(),
    };

    const summary: MeetingSummary = {
      summary: 'Meeting.',
      keyDecisions: [],
      actionItems: [{ description: 'Send report' }],
      nextSteps: [],
      sentiment: 'neutral',
      topics: [],
    };

    const generator = createTaskGenerator(client, mockLogger);
    const result = await generator.generateTasks({
      meetingSummary: summary,
      opportunityId: 'opp-1',
      opportunityName: 'Deal',
      activityId: 'act-1',
      signalId: 'sig-1',
      ownerUserId: 'user-1',
    });

    expect(result.tasksFailed).toBe(1);
    expect(result.tasksCreated).toBe(0);
    expect(result.tasks[0].status).toBe('failed');
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('returns empty result when no action items', async () => {
    const client: DataverseClient = {
      get: vi.fn(),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const summary: MeetingSummary = {
      summary: 'No tasks discussed.',
      keyDecisions: [],
      actionItems: [],
      nextSteps: [],
      sentiment: 'neutral',
      topics: [],
    };

    const generator = createTaskGenerator(client, mockLogger);
    const result = await generator.generateTasks({
      meetingSummary: summary,
      opportunityId: 'opp-1',
      opportunityName: 'Deal',
      activityId: 'act-1',
      signalId: 'sig-1',
      ownerUserId: 'user-1',
    });

    expect(result.totalActionItems).toBe(0);
    expect(result.tasksCreated).toBe(0);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('sets high priority for tasks with due dates', async () => {
    const mockGet = vi.fn().mockResolvedValue([]);
    const mockCreate = vi.fn().mockResolvedValue('task-1');

    const client: DataverseClient = {
      get: mockGet,
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: mockCreate,
      update: vi.fn(),
    };

    const summary: MeetingSummary = {
      summary: 'Meeting.',
      keyDecisions: [],
      actionItems: [{ description: 'Urgent task', dueDate: '2026-03-25' }],
      nextSteps: [],
      sentiment: 'neutral',
      topics: [],
    };

    const generator = createTaskGenerator(client, mockLogger);
    await generator.generateTasks({
      meetingSummary: summary,
      opportunityId: 'opp-1',
      opportunityName: 'Deal',
      activityId: 'act-1',
      signalId: 'sig-1',
      ownerUserId: 'user-1',
    });

    // Check that create was called with prioritycode 2 (High)
    const createCall = mockCreate.mock.calls[0];
    expect(createCall[1].prioritycode).toBe(2);
    expect(createCall[1].scheduledend).toBe('2026-03-25');
  });
});
