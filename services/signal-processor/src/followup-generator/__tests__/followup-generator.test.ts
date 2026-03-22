import { describe, it, expect, vi } from 'vitest';
import { parseEmailDraftResponse, buildPrompt } from '../index.js';
import { type MeetingSummary } from '../../shared/types.js';

describe('parseEmailDraftResponse', () => {
  it('parses valid JSON response', () => {
    const raw = JSON.stringify({
      subject: 'Re: Q4 Planning — Follow-Up',
      body: 'Hi team,\n\nThank you for the productive meeting.',
      tone: 'professional',
    });

    const result = parseEmailDraftResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.subject).toBe('Re: Q4 Planning — Follow-Up');
    expect(result!.body).toContain('productive meeting');
    expect(result!.tone).toBe('professional');
  });

  it('handles JSON wrapped in markdown code fences', () => {
    const raw = '```json\n{"subject":"Test","body":"Hello","tone":"formal"}\n```';
    const result = parseEmailDraftResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.subject).toBe('Test');
    expect(result!.tone).toBe('formal');
  });

  it('returns null for empty subject', () => {
    const raw = JSON.stringify({ subject: '', body: 'Hello', tone: 'professional' });
    expect(parseEmailDraftResponse(raw)).toBeNull();
  });

  it('returns null for empty body', () => {
    const raw = JSON.stringify({ subject: 'Test', body: '', tone: 'professional' });
    expect(parseEmailDraftResponse(raw)).toBeNull();
  });

  it('defaults tone to professional when invalid', () => {
    const raw = JSON.stringify({ subject: 'Test', body: 'Hello', tone: 'aggressive' });
    const result = parseEmailDraftResponse(raw);
    expect(result!.tone).toBe('professional');
  });

  it('returns null for invalid JSON', () => {
    expect(parseEmailDraftResponse('not json')).toBeNull();
  });
});

describe('buildPrompt', () => {
  const baseSummary: MeetingSummary = {
    summary: 'We discussed the Q4 roadmap and agreed on key priorities.',
    keyDecisions: ['Approved budget for Phase 2'],
    actionItems: [
      { description: 'Send proposal draft', assignee: 'John', dueDate: '2026-04-01' },
    ],
    nextSteps: ['Schedule technical review'],
    sentiment: 'positive',
    topics: ['roadmap', 'budget'],
  };

  it('includes meeting context in prompt', () => {
    const prompt = buildPrompt({
      meetingSummary: baseSummary,
      opportunityName: 'Contoso Enterprise',
      accountName: 'Contoso Ltd',
      senderName: 'Jane Smith',
      recipientNames: ['Bob Jones', 'Alice Lee'],
      meetingDate: '2026-03-20',
      meetingSubject: 'Q4 Planning',
      tenantId: 't1',
      userId: 'u1',
    });

    expect(prompt).toContain('Q4 Planning');
    expect(prompt).toContain('Contoso Ltd');
    expect(prompt).toContain('Jane Smith');
    expect(prompt).toContain('Bob Jones');
    expect(prompt).toContain('Send proposal draft');
    expect(prompt).toContain('Approved budget');
  });

  it('includes action items with assignees and due dates', () => {
    const prompt = buildPrompt({
      meetingSummary: baseSummary,
      opportunityName: 'Test',
      accountName: 'Test Co',
      senderName: 'Sender',
      recipientNames: ['Recipient'],
      meetingDate: '2026-03-20',
      meetingSubject: 'Test',
      tenantId: 't1',
      userId: 'u1',
    });

    expect(prompt).toContain('John');
    expect(prompt).toContain('2026-04-01');
  });

  it('handles empty arrays gracefully', () => {
    const emptySummary: MeetingSummary = {
      summary: 'Brief meeting.',
      keyDecisions: [],
      actionItems: [],
      nextSteps: [],
      sentiment: 'neutral',
      topics: [],
    };

    const prompt = buildPrompt({
      meetingSummary: emptySummary,
      opportunityName: 'Test',
      accountName: 'Test Co',
      senderName: 'Sender',
      recipientNames: ['Recipient'],
      meetingDate: '2026-03-20',
      meetingSubject: 'Test',
      tenantId: 't1',
      userId: 'u1',
    });

    expect(prompt).toContain('Brief meeting.');
    expect(prompt).not.toContain('Key Decisions');
    expect(prompt).not.toContain('Action Items');
  });
});
