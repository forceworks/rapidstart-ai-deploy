/**
 * Task Generator — creates Dataverse Task records from detected action items.
 *
 * Input: action items from AI Summarizer meeting summaries
 * Output: CRM Task records linked to the opportunity/account
 *
 * Tasks are created with:
 *   - Subject from action item description
 *   - Due date from action item (if detected)
 *   - Linked to the opportunity via regardingobjectid
 *   - Marked as AI-generated (fw_aisource = true)
 *   - Idempotent: keyed on signalId + action item index
 */

import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';
import { type MeetingSummary, type ActionItem } from '../shared/types.js';

export interface TaskGeneratorService {
  /** Create tasks from meeting action items */
  generateTasks(params: TaskGenerationRequest): Promise<TaskGenerationResult>;
}

export interface TaskGenerationRequest {
  meetingSummary: MeetingSummary;
  opportunityId: string;
  opportunityName: string;
  accountId?: string;
  activityId: string;
  signalId: string;
  ownerUserId: string;
}

export interface TaskGenerationResult {
  totalActionItems: number;
  tasksCreated: number;
  tasksSkipped: number;
  tasksFailed: number;
  tasks: GeneratedTask[];
}

export interface GeneratedTask {
  taskId?: string;
  subject: string;
  dueDate?: string;
  assignee?: string;
  status: 'created' | 'skipped' | 'failed';
  reason?: string;
}

interface ExistingTaskRecord {
  activityid: string;
  subject: string;
}

export function createTaskGenerator(
  dataverseClient: DataverseClient,
  logger: Logger
): TaskGeneratorService {
  /**
   * Check if a task already exists for this signal + action item (idempotency).
   */
  async function taskExists(signalId: string, subject: string): Promise<boolean> {
    try {
      const existing = await dataverseClient.get<ExistingTaskRecord>(
        'tasks',
        `$filter=fw_signalid eq '${signalId}' and contains(subject, '${escapeOData(subject.substring(0, 50))}')&$select=activityid,subject&$top=1`
      );
      return existing.length > 0;
    } catch {
      return false;
    }
  }

  return {
    async generateTasks(params: TaskGenerationRequest): Promise<TaskGenerationResult> {
      const startTime = Date.now();
      const { meetingSummary, opportunityId, activityId, signalId, ownerUserId } = params;
      const actionItems = meetingSummary.actionItems;

      const result: TaskGenerationResult = {
        totalActionItems: actionItems.length,
        tasksCreated: 0,
        tasksSkipped: 0,
        tasksFailed: 0,
        tasks: [],
      };

      if (actionItems.length === 0) {
        logger.info('No action items to generate tasks from', { signalId });
        return result;
      }

      for (let i = 0; i < actionItems.length; i++) {
        const item = actionItems[i];
        const subject = `[AI] ${item.description}`;

        // Idempotency check
        const exists = await taskExists(signalId, item.description);
        if (exists) {
          result.tasksSkipped++;
          result.tasks.push({
            subject,
            dueDate: item.dueDate,
            assignee: item.assignee,
            status: 'skipped',
            reason: 'Task already exists for this signal',
          });
          continue;
        }

        try {
          const taskData: Record<string, unknown> = {
            subject,
            description: buildTaskDescription(item, params),
            ['regardingobjectid_opportunity@odata.bind']: `/opportunities(${opportunityId})`,
            fw_aisource: true,
            fw_signalid: signalId,
            fw_aicreated: true,
            prioritycode: item.dueDate ? 2 : 1, // 2 = High if has due date, 1 = Normal
          };

          // Set due date if available
          if (item.dueDate) {
            taskData.scheduledend = item.dueDate;
          }

          // Link to source activity
          if (activityId) {
            taskData.fw_sourceactivityid = activityId;
          }

          const taskId = await dataverseClient.create('tasks', taskData);

          result.tasksCreated++;
          result.tasks.push({
            taskId,
            subject,
            dueDate: item.dueDate,
            assignee: item.assignee,
            status: 'created',
          });
        } catch (error) {
          result.tasksFailed++;
          result.tasks.push({
            subject,
            dueDate: item.dueDate,
            assignee: item.assignee,
            status: 'failed',
            reason: String(error),
          });

          logger.warn('Failed to create task from action item', {
            signalId,
            itemIndex: String(i),
            error: String(error),
          });
        }
      }

      const durationMs = Date.now() - startTime;
      logger.info('Task generation complete', {
        signalId,
        opportunityId,
        total: String(result.totalActionItems),
        created: String(result.tasksCreated),
        skipped: String(result.tasksSkipped),
        failed: String(result.tasksFailed),
        durationMs: String(durationMs),
      });

      return result;
    },
  };
}

function buildTaskDescription(item: ActionItem, params: TaskGenerationRequest): string {
  let desc = `Auto-generated from AI meeting summary.\n\n`;
  desc += `Action Item: ${item.description}\n`;

  if (item.assignee) {
    desc += `Assignee: ${item.assignee}\n`;
  }
  if (item.dueDate) {
    desc += `Due: ${item.dueDate}\n`;
  }

  desc += `\nSource: Meeting "${params.opportunityName}"`;
  desc += `\nSignal ID: ${params.signalId}`;

  return desc;
}

function escapeOData(str: string): string {
  return str.replace(/'/g, "''");
}
