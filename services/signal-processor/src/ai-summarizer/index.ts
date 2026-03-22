/**
 * AI Summarizer — fetches meeting context and calls Azure OpenAI
 * for structured summary extraction.
 *
 * Architectural rules:
 *   - Usage governance pre-check before any OpenAI call
 *   - Graceful degradation: if AI fails, return success=false, never throw
 *   - Schema validation on OpenAI response
 *   - Record usage after successful call
 */

import { type AppConfig } from '../shared/config.js';
import { type Logger } from '../shared/logger.js';
import { type TokenProvider, getGraphToken } from '../shared/credentials.js';
import { type UsageGovernanceService } from '../shared/usage-governance.js';
import {
  type Signal,
  type MeetingSummary,
  type SummarizationResult,
} from '../shared/types.js';

export interface AISummarizerService {
  /** Summarize a meeting signal. Returns success=false on failure (never throws). */
  summarize(signal: Signal): Promise<SummarizationResult>;
}

export interface AISummarizerDeps {
  config: AppConfig['openai'];
  logger: Logger;
  tokenProvider: TokenProvider;
  usageGovernance: UsageGovernanceService;
}

/** System prompt for structured meeting summary extraction */
const SYSTEM_PROMPT = `You are an AI assistant that extracts structured summaries from meeting information.
Given meeting details (subject, participants, time, and any available transcript or body text),
produce a JSON object with this exact schema:

{
  "summary": "2-3 sentence overview of the meeting",
  "keyDecisions": ["decision 1", "decision 2"],
  "actionItems": [
    {"description": "task description", "assignee": "person name or email", "dueDate": "YYYY-MM-DD or null"}
  ],
  "nextSteps": ["next step 1", "next step 2"],
  "sentiment": "positive" | "neutral" | "negative",
  "topics": ["topic1", "topic2"]
}

Rules:
- If insufficient information is available, still produce the JSON with best-effort content
- summary is always required, even if brief
- keyDecisions, actionItems, nextSteps, topics can be empty arrays
- sentiment must be exactly one of: positive, neutral, negative
- Keep all text concise and professional
- Respond ONLY with the JSON object, no markdown or explanation`;

/**
 * Build the user prompt from signal data and optional transcript.
 */
function buildUserPrompt(signal: Signal, transcript?: string): string {
  const participantList = signal.participants
    .map((p) => p.displayName ? `${p.displayName} <${p.email}>` : p.email)
    .join(', ');

  let prompt = `Meeting Subject: ${signal.subject}
Date/Time: ${signal.startTime}${signal.endTime ? ` to ${signal.endTime}` : ''}
Participants: ${participantList}
Organizer: ${signal.userEmail}`;

  // Include body/notes from raw payload if available
  const body = extractBody(signal.rawPayload);
  if (body) {
    prompt += `\n\nMeeting Notes/Body:\n${body}`;
  }

  if (transcript) {
    prompt += `\n\nTranscript:\n${transcript}`;
  }

  return prompt;
}

/**
 * Extract meeting body/notes from the raw Graph event payload.
 */
function extractBody(rawPayload: Record<string, unknown>): string | null {
  // Graph event body is at body.content
  const body = rawPayload.body as { content?: string; contentType?: string } | undefined;
  if (!body?.content) return null;

  // Strip HTML tags if contentType is HTML
  if (body.contentType === 'html' || body.contentType === 'HTML') {
    return body.content
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return body.content.trim();
}

/**
 * Attempt to fetch a meeting transcript from Microsoft Graph.
 * Returns null if no transcript is available (common for most meetings).
 */
async function fetchTranscript(
  signal: Signal,
  tokenProvider: TokenProvider,
  logger: Logger
): Promise<string | null> {
  try {
    const token = await getGraphToken(tokenProvider);

    // Graph API: GET /users/{userId}/onlineMeetings/{meetingId}/transcripts
    // The event may have an onlineMeeting join URL in the raw payload
    const onlineMeeting = signal.rawPayload.onlineMeeting as
      { joinUrl?: string } | undefined;

    if (!onlineMeeting?.joinUrl) {
      logger.info('No online meeting join URL — skipping transcript fetch', {
        signalId: signal.id,
      });
      return null;
    }

    // Look up the online meeting by join URL
    const encodedJoinUrl = encodeURIComponent(onlineMeeting.joinUrl);
    const meetingResponse = await fetch(
      `https://graph.microsoft.com/v1.0/users/${signal.userId}/onlineMeetings?$filter=joinWebUrl eq '${encodedJoinUrl}'`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      }
    );

    if (!meetingResponse.ok) {
      logger.info('Online meeting lookup returned non-OK', {
        signalId: signal.id,
        status: String(meetingResponse.status),
      });
      return null;
    }

    const meetingData = (await meetingResponse.json()) as {
      value: Array<{ id: string }>;
    };
    if (!meetingData.value?.length) return null;

    const meetingId = meetingData.value[0].id;

    // Fetch transcripts list
    const transcriptsResponse = await fetch(
      `https://graph.microsoft.com/v1.0/users/${signal.userId}/onlineMeetings/${meetingId}/transcripts`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      }
    );

    if (!transcriptsResponse.ok) return null;

    const transcriptsData = (await transcriptsResponse.json()) as {
      value: Array<{ id: string }>;
    };
    if (!transcriptsData.value?.length) return null;

    // Fetch the first transcript content
    const transcriptId = transcriptsData.value[0].id;
    const contentResponse = await fetch(
      `https://graph.microsoft.com/v1.0/users/${signal.userId}/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=text/vtt`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/vtt',
        },
      }
    );

    if (!contentResponse.ok) return null;

    const content = await contentResponse.text();

    // Truncate extremely long transcripts to avoid token limits
    const MAX_TRANSCRIPT_CHARS = 30000;
    if (content.length > MAX_TRANSCRIPT_CHARS) {
      logger.info('Transcript truncated', {
        signalId: signal.id,
        originalLength: String(content.length),
        truncatedTo: String(MAX_TRANSCRIPT_CHARS),
      });
      return content.substring(0, MAX_TRANSCRIPT_CHARS) + '\n[...transcript truncated]';
    }

    return content;
  } catch (error) {
    // Graceful degradation — transcript is optional
    logger.info('Transcript fetch failed (non-critical)', {
      signalId: signal.id,
      error: String(error),
    });
    return null;
  }
}

/**
 * Validate and parse the OpenAI response into a MeetingSummary.
 */
export function parseSummaryResponse(raw: string): MeetingSummary | null {
  try {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(cleaned);

    // Validate required fields
    if (typeof parsed.summary !== 'string' || !parsed.summary) return null;

    const validSentiments = ['positive', 'neutral', 'negative'];
    if (!validSentiments.includes(parsed.sentiment)) {
      parsed.sentiment = 'neutral';
    }

    // Normalize arrays — ensure they exist and contain strings
    const summary: MeetingSummary = {
      summary: parsed.summary,
      keyDecisions: Array.isArray(parsed.keyDecisions)
        ? parsed.keyDecisions.filter((d: unknown) => typeof d === 'string')
        : [],
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems
            .filter((a: unknown) => typeof a === 'object' && a !== null)
            .map((a: Record<string, unknown>) => ({
              description: String(a.description || ''),
              assignee: a.assignee ? String(a.assignee) : undefined,
              dueDate: a.dueDate ? String(a.dueDate) : undefined,
            }))
            .filter((a: { description: string }) => a.description.length > 0)
        : [],
      nextSteps: Array.isArray(parsed.nextSteps)
        ? parsed.nextSteps.filter((s: unknown) => typeof s === 'string')
        : [],
      sentiment: parsed.sentiment,
      topics: Array.isArray(parsed.topics)
        ? parsed.topics.filter((t: unknown) => typeof t === 'string')
        : [],
    };

    return summary;
  } catch {
    return null;
  }
}

export function createAISummarizer(deps: AISummarizerDeps): AISummarizerService {
  const { config, logger, tokenProvider, usageGovernance } = deps;

  return {
    async summarize(signal: Signal): Promise<SummarizationResult> {
      const startTime = Date.now();
      const deployment = config.deployment;

      try {
        // Step 1: Pre-spend usage governance check
        const usageCheck = await usageGovernance.checkUsage(signal.tenantId, signal.userId);
        if (!usageCheck.allowed) {
          logger.warn('AI summarization skipped — usage limit reached', {
            signalId: signal.id,
            reason: usageCheck.reason || 'limit reached',
          });
          return {
            success: false,
            tokensUsed: 0,
            modelDeployment: deployment,
            errorMessage: usageCheck.reason || 'Usage limit reached',
          };
        }

        // Step 2: Attempt transcript fetch (optional, graceful degradation)
        const transcript = await fetchTranscript(signal, tokenProvider, logger);

        // Step 3: Build the prompt
        const userPrompt = buildUserPrompt(signal, transcript || undefined);

        // Step 4: Call Azure OpenAI
        const apiUrl = `${config.endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;

        const requestBody = {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
        };

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        // Use API key if available, otherwise use token-based auth
        if (config.keySource === 'environment' && config.apiKey) {
          headers['api-key'] = config.apiKey;
        } else {
          const token = await tokenProvider.getToken(['https://cognitiveservices.azure.com/.default']);
          headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`OpenAI API returned ${response.status}: ${errorText}`);
        }

        const result = (await response.json()) as {
          choices: Array<{ message: { content: string } }>;
          usage: { total_tokens: number };
        };

        const rawContent = result.choices?.[0]?.message?.content;
        const tokensUsed = result.usage?.total_tokens || 0;

        if (!rawContent) {
          throw new Error('OpenAI response contained no content');
        }

        // Step 5: Parse and validate the structured response
        const meetingSummary = parseSummaryResponse(rawContent);
        if (!meetingSummary) {
          throw new Error('Failed to parse OpenAI response into MeetingSummary schema');
        }

        // Step 6: Record usage (post-spend)
        await usageGovernance.recordUsage(signal.tenantId, signal.userId);

        const durationMs = Date.now() - startTime;
        logger.trackSignal(signal.id, 'meeting-summarized', {
          tokensUsed: String(tokensUsed),
          hasTranscript: String(!!transcript),
          sentiment: meetingSummary.sentiment,
          actionItemCount: String(meetingSummary.actionItems.length),
          durationMs: String(durationMs),
        });

        return {
          success: true,
          meetingSummary,
          tokensUsed,
          modelDeployment: deployment,
        };
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Graceful degradation — never throw, return failure
        logger.warn('AI summarization failed (non-fatal)', {
          signalId: signal.id,
          error: errorMessage,
          durationMs: String(durationMs),
        });

        return {
          success: false,
          tokensUsed: 0,
          modelDeployment: deployment,
          errorMessage,
        };
      }
    },
  };
}

// Export helpers for testing
export { buildUserPrompt, extractBody, fetchTranscript };
