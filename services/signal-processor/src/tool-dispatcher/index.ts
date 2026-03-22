/**
 * Tool Dispatcher — invokes Dataverse Custom APIs to create CRM records.
 *
 * Available tools:
 *   fw_LogMeeting   — create an Appointment activity linked to an Account
 *   fw_CreateContact — create a Contact (idempotent by email)
 *
 * All CRM writes go through Custom APIs — never raw Dataverse entity creation.
 */

import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';
import { type Signal, type ConfidenceResult, type MeetingSummary } from '../shared/types.js';
import { type Recommendation } from '../nextstep-recommender/index.js';

export interface ToolDispatcherService {
  /** Log a meeting activity via fw_LogMeeting Custom API */
  logMeeting(signal: Signal, confidenceResult: ConfidenceResult): Promise<LogMeetingResponse>;
  /** Create a contact via fw_CreateContact Custom API */
  createContact(email: string, displayName?: string, accountId?: string): Promise<CreateContactResponse>;
  /** Add AI-generated meeting notes via fw_AddMeetingNotes Custom API */
  addMeetingNotes(activityId: string, summary: MeetingSummary, signalId: string): Promise<AddMeetingNotesResponse>;
  /** Persist a follow-up suggestion via fw_SuggestFollowUp Custom API */
  suggestFollowUp(opportunityId: string, recommendation: Recommendation, signalId: string, suggestedContent?: string): Promise<SuggestFollowUpResponse>;
}

export interface LogMeetingRequest {
  accountid?: string;
  meetingsubject: string;
  meetingstart: string;
  meetingend?: string;
  participantemails: string;
  confidencescore?: number;
  signalid?: string;
  graphresourceid?: string;
}

export interface LogMeetingResponse {
  activityid: string;
  success: boolean;
  message: string;
}

export interface CreateContactRequest {
  email: string;
  displayname?: string;
  accountid?: string;
}

export interface CreateContactResponse {
  contactid: string;
  success: boolean;
  message: string;
  alreadyexisted: boolean;
}

export interface AddMeetingNotesRequest {
  activityid: string;
  summary: string;
  keydecisions: string;
  actionitems: string;
  nextsteps: string;
  sentiment: string;
  topics: string;
  aigenerated: boolean;
}

export interface AddMeetingNotesResponse {
  success: boolean;
  message: string;
}

export interface SuggestFollowUpRequest {
  opportunityid: string;
  suggestiontype: string;
  title: string;
  description: string;
  suggestedcontent: string;
  triggersignal: string;
  actiondata: string;
  priority: string;
}

export interface SuggestFollowUpResponse {
  suggestionid: string;
  success: boolean;
  message: string;
}

export function createToolDispatcher(
  dataverseClient: DataverseClient,
  logger: Logger
): ToolDispatcherService {
  return {
    async logMeeting(signal: Signal, confidenceResult: ConfidenceResult): Promise<LogMeetingResponse> {
      const participantEmails = signal.participants.map((p) => p.email).join(';');

      const request: LogMeetingRequest = {
        meetingsubject: signal.subject,
        meetingstart: signal.startTime,
        meetingend: signal.endTime,
        participantemails: participantEmails,
        confidencescore: confidenceResult.overallConfidence,
        signalid: signal.id,
        graphresourceid: signal.graphResourceId,
      };

      // Attach account if we have a confident match
      if (confidenceResult.accountMatch) {
        request.accountid = confidenceResult.accountMatch.entityId;
      }

      logger.info('Dispatching fw_LogMeeting', {
        signalId: signal.id,
        accountId: request.accountid || 'none',
        participantCount: String(signal.participants.length),
      });

      const response = await dataverseClient.executeAction<LogMeetingRequest, LogMeetingResponse>(
        'fw_LogMeeting',
        request
      );

      logger.trackSignal(signal.id, 'meeting-logged', {
        activityId: response.activityid,
        success: String(response.success),
      });

      return response;
    },

    async createContact(email: string, displayName?: string, accountId?: string): Promise<CreateContactResponse> {
      const request: CreateContactRequest = {
        email,
        displayname: displayName,
        accountid: accountId,
      };

      logger.info('Dispatching fw_CreateContact', {
        email,
        accountId: accountId || 'none',
      });

      const response = await dataverseClient.executeAction<CreateContactRequest, CreateContactResponse>(
        'fw_CreateContact',
        request
      );

      logger.info('Contact creation result', {
        contactId: response.contactid,
        alreadyExisted: String(response.alreadyexisted),
      });

      return response;
    },

    async addMeetingNotes(
      activityId: string,
      summary: MeetingSummary,
      signalId: string
    ): Promise<AddMeetingNotesResponse> {
      const request: AddMeetingNotesRequest = {
        activityid: activityId,
        summary: summary.summary,
        keydecisions: JSON.stringify(summary.keyDecisions),
        actionitems: JSON.stringify(summary.actionItems),
        nextsteps: JSON.stringify(summary.nextSteps),
        sentiment: summary.sentiment,
        topics: JSON.stringify(summary.topics),
        aigenerated: true,
      };

      logger.info('Dispatching fw_AddMeetingNotes', {
        activityId,
        signalId,
        actionItemCount: String(summary.actionItems.length),
      });

      const response = await dataverseClient.executeAction<AddMeetingNotesRequest, AddMeetingNotesResponse>(
        'fw_AddMeetingNotes',
        request
      );

      logger.trackSignal(signalId, 'meeting-notes-added', {
        activityId,
        success: String(response.success),
      });

      return response;
    },

    async suggestFollowUp(
      opportunityId: string,
      recommendation: Recommendation,
      signalId: string,
      suggestedContent?: string
    ): Promise<SuggestFollowUpResponse> {
      const request: SuggestFollowUpRequest = {
        opportunityid: opportunityId,
        suggestiontype: recommendation.type,
        title: recommendation.title,
        description: recommendation.description,
        suggestedcontent: suggestedContent || '',
        triggersignal: signalId,
        actiondata: JSON.stringify(recommendation.actionData),
        priority: recommendation.priority,
      };

      logger.info('Dispatching fw_SuggestFollowUp', {
        opportunityId,
        type: recommendation.type,
        priority: recommendation.priority,
        signalId,
      });

      const response = await dataverseClient.executeAction<SuggestFollowUpRequest, SuggestFollowUpResponse>(
        'fw_SuggestFollowUp',
        request
      );

      logger.trackSignal(signalId, 'suggestion-created', {
        suggestionId: response.suggestionid,
        type: recommendation.type,
        success: String(response.success),
      });

      return response;
    },
  };
}
