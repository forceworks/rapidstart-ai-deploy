/**
 * Follow-Up Email Draft Generator — creates draft follow-up emails
 * from meeting summaries using Azure OpenAI.
 *
 * Input: a meeting summary (from AI Summarizer) + opportunity/account context
 * Output: a professional follow-up email draft ready for salesperson review
 *
 * Architectural rules:
 *   - Pre-spend usage governance before any OpenAI call
 *   - Graceful degradation: return success=false, never throw
 *   - Drafts are always suggestions — salesperson reviews before sending
 */

import { type AppConfig } from '../shared/config.js';
import { type Logger } from '../shared/logger.js';
import { type TokenProvider } from '../shared/credentials.js';
import { type UsageGovernanceService } from '../shared/usage-governance.js';
import { type MeetingSummary } from '../shared/types.js';

export interface FollowUpGeneratorService {
  /** Generate a follow-up email draft from a meeting summary */
  generateDraft(params: FollowUpDraftRequest): Promise<FollowUpDraftResult>;
}

export interface FollowUpDraftRequest {
  meetingSummary: MeetingSummary;
  opportunityName: string;
  accountName: string;
  senderName: string;
  recipientNames: string[];
  meetingDate: string;
  meetingSubject: string;
  tenantId: string;
  userId: string;
}

export interface FollowUpDraftResult {
  success: boolean;
  draft?: EmailDraft;
  tokensUsed: number;
  errorMessage?: string;
}

export interface EmailDraft {
  subject: string;
  body: string;
  tone: 'formal' | 'professional' | 'casual';
}

export interface FollowUpGeneratorDeps {
  config: AppConfig['openai'];
  logger: Logger;
  tokenProvider: TokenProvider;
  usageGovernance: UsageGovernanceService;
}

const SYSTEM_PROMPT = `You are a sales communication assistant. Given a meeting summary and context,
generate a professional follow-up email draft.

Respond ONLY with a JSON object using this exact schema:
{
  "subject": "Re: [meeting subject] — Follow-Up",
  "body": "Full email body text with paragraphs separated by \\n\\n",
  "tone": "professional"
}

Rules:
- Start with a warm reference to the meeting
- Summarize key discussion points briefly (2-3 sentences)
- List any agreed action items with owners
- Propose clear next steps
- Keep it concise (150-250 words)
- Use a professional but warm tone
- Do NOT include email headers (To, From, etc.) — just the body text
- tone must be exactly one of: formal, professional, casual`;

function buildPrompt(params: FollowUpDraftRequest): string {
  const { meetingSummary, opportunityName, accountName, senderName, recipientNames, meetingDate, meetingSubject } = params;

  let prompt = `Meeting: ${meetingSubject}
Date: ${meetingDate}
Account: ${accountName}
Opportunity: ${opportunityName}
Sender (salesperson): ${senderName}
Recipients: ${recipientNames.join(', ')}

Meeting Summary: ${meetingSummary.summary}
Sentiment: ${meetingSummary.sentiment}`;

  if (meetingSummary.keyDecisions.length > 0) {
    prompt += `\n\nKey Decisions:\n${meetingSummary.keyDecisions.map((d) => `- ${d}`).join('\n')}`;
  }

  if (meetingSummary.actionItems.length > 0) {
    prompt += `\n\nAction Items:\n${meetingSummary.actionItems.map((a) => `- ${a.description}${a.assignee ? ` (${a.assignee})` : ''}${a.dueDate ? ` by ${a.dueDate}` : ''}`).join('\n')}`;
  }

  if (meetingSummary.nextSteps.length > 0) {
    prompt += `\n\nNext Steps:\n${meetingSummary.nextSteps.map((s) => `- ${s}`).join('\n')}`;
  }

  return prompt;
}

export function parseEmailDraftResponse(raw: string): EmailDraft | null {
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(cleaned);

    if (typeof parsed.subject !== 'string' || !parsed.subject) return null;
    if (typeof parsed.body !== 'string' || !parsed.body) return null;

    const validTones = ['formal', 'professional', 'casual'];
    if (!validTones.includes(parsed.tone)) {
      parsed.tone = 'professional';
    }

    return {
      subject: parsed.subject,
      body: parsed.body,
      tone: parsed.tone,
    };
  } catch {
    return null;
  }
}

export function createFollowUpGenerator(deps: FollowUpGeneratorDeps): FollowUpGeneratorService {
  const { config, logger, tokenProvider, usageGovernance } = deps;

  return {
    async generateDraft(params: FollowUpDraftRequest): Promise<FollowUpDraftResult> {
      const startTime = Date.now();

      try {
        // Pre-spend governance check
        const usageCheck = await usageGovernance.checkUsage(params.tenantId, params.userId);
        if (!usageCheck.allowed) {
          logger.warn('Follow-up generation skipped — usage limit', {
            reason: usageCheck.reason || 'limit reached',
          });
          return {
            success: false,
            tokensUsed: 0,
            errorMessage: usageCheck.reason || 'Usage limit reached',
          };
        }

        const userPrompt = buildPrompt(params);

        const apiUrl = `${config.endpoint.replace(/\/$/, '')}/openai/deployments/${config.deployment}/chat/completions?api-version=2024-08-01-preview`;

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        if (config.keySource === 'environment' && config.apiKey) {
          headers['api-key'] = config.apiKey;
        } else {
          const token = await tokenProvider.getToken(['https://cognitiveservices.azure.com/.default']);
          headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.5,
            max_tokens: 1500,
            response_format: { type: 'json_object' },
          }),
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

        const draft = parseEmailDraftResponse(rawContent);
        if (!draft) {
          throw new Error('Failed to parse email draft from OpenAI response');
        }

        await usageGovernance.recordUsage(params.tenantId, params.userId);

        const durationMs = Date.now() - startTime;
        logger.info('Follow-up email draft generated', {
          opportunity: params.opportunityName,
          tokensUsed: String(tokensUsed),
          durationMs: String(durationMs),
        });

        return { success: true, draft, tokensUsed };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('Follow-up generation failed (non-fatal)', {
          error: errorMessage,
          durationMs: String(Date.now() - startTime),
        });
        return { success: false, tokensUsed: 0, errorMessage };
      }
    },
  };
}

export { buildPrompt };
