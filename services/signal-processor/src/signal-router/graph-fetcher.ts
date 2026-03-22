/**
 * Fetches full calendar event details from Microsoft Graph API
 * and maps them to the canonical Signal type.
 */

import { type TokenProvider, getGraphToken } from '../shared/credentials.js';
import { type Logger } from '../shared/logger.js';
import { type Signal, type Participant } from '../shared/types.js';
import { v4 as uuidv4 } from 'uuid';

export interface GraphEventFetcher {
  getCalendarEvent(userId: string, eventId: string): Promise<Signal>;
}

interface GraphCalendarEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  organizer: {
    emailAddress: { name: string; address: string };
  };
  attendees: Array<{
    emailAddress: { name: string; address: string };
    status: { response: string };
    type: string;
  }>;
  [key: string]: unknown;
}

export function createGraphEventFetcher(
  tokenProvider: TokenProvider,
  logger: Logger
): GraphEventFetcher {
  return {
    async getCalendarEvent(userId: string, eventId: string): Promise<Signal> {
      const startTime = Date.now();
      const token = await getGraphToken(tokenProvider);

      const url = `https://graph.microsoft.com/v1.0/users/${userId}/events/${eventId}?$select=id,subject,start,end,organizer,attendees`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const durationMs = Date.now() - startTime;
      logger.trackDependency('Graph.GetEvent', durationMs, response.ok, url);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Graph API error ${response.status}: ${errorText}`);
      }

      const event = (await response.json()) as GraphCalendarEvent;

      // Map attendees to participants
      const participants: Participant[] = (event.attendees || []).map((a) => ({
        email: a.emailAddress.address.toLowerCase(),
        displayName: a.emailAddress.name,
        responseStatus: a.status?.response,
      }));

      // Add organizer as participant if not already in list
      const organizerEmail = event.organizer?.emailAddress?.address?.toLowerCase();
      if (organizerEmail && !participants.some((p) => p.email === organizerEmail)) {
        participants.push({
          email: organizerEmail,
          displayName: event.organizer.emailAddress.name,
          responseStatus: 'organizer',
        });
      }

      // Construct the Signal
      const signal: Signal = {
        id: uuidv4(),
        graphResourceId: event.id,
        signalType: 'meeting',
        tenantId: '', // will be set by the router from the notification
        userId,
        userEmail: organizerEmail || '',
        subject: event.subject || '(No subject)',
        startTime: event.start.dateTime,
        endTime: event.end?.dateTime,
        participants,
        rawPayload: event as unknown as Record<string, unknown>,
        receivedAt: new Date().toISOString(),
      };

      logger.trackSignal(signal.id, 'fetched', {
        graphResourceId: event.id,
        participantCount: String(participants.length),
      });

      return signal;
    },
  };
}
