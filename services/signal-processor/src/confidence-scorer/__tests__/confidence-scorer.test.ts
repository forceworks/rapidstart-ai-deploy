import { describe, it, expect } from 'vitest';
import { createConfidenceScorer } from '../index.js';
import { type EntityMatch } from '../../shared/types.js';

function makeMatch(overrides: Partial<EntityMatch> & { entityType: 'account' | 'contact' }): EntityMatch {
  return {
    entityId: 'id-1',
    entityName: 'Test Entity',
    matchField: 'emailaddress1',
    matchValue: 'test@company.com',
    confidence: 0.95,
    ...overrides,
  };
}

describe('confidenceScorer', () => {
  const scorer = createConfidenceScorer();

  it('returns 0.95 for account + contact match (via contact-parent)', () => {
    const matches: EntityMatch[] = [
      makeMatch({ entityType: 'contact', entityId: 'c1', confidence: 0.95 }),
      makeMatch({ entityType: 'account', entityId: 'a1', matchField: 'contact-parent', confidence: 0.95 }),
    ];

    const result = scorer.score(matches);

    expect(result.overallConfidence).toBe(0.95);
    expect(result.requiresReview).toBe(false);
    expect(result.accountMatch).toBeDefined();
    expect(result.contactMatches).toHaveLength(1);
  });

  it('returns 0.80 for account domain + contact match', () => {
    const matches: EntityMatch[] = [
      makeMatch({ entityType: 'contact', entityId: 'c1', confidence: 0.95 }),
      makeMatch({ entityType: 'account', entityId: 'a1', matchField: 'emailaddress1-domain', confidence: 0.70 }),
    ];

    const result = scorer.score(matches);

    expect(result.overallConfidence).toBe(0.80);
    expect(result.requiresReview).toBe(false);
  });

  it('returns 0.70 for account domain only (at threshold)', () => {
    const matches: EntityMatch[] = [
      makeMatch({ entityType: 'account', entityId: 'a1', matchField: 'emailaddress1-domain', confidence: 0.70 }),
    ];

    const result = scorer.score(matches);

    expect(result.overallConfidence).toBe(0.70);
    expect(result.requiresReview).toBe(false);
  });

  it('returns 0.60 for account website only (below threshold → review)', () => {
    const matches: EntityMatch[] = [
      makeMatch({ entityType: 'account', entityId: 'a1', matchField: 'websiteurl', confidence: 0.60 }),
    ];

    const result = scorer.score(matches);

    expect(result.overallConfidence).toBe(0.60);
    expect(result.requiresReview).toBe(true);
  });

  it('returns 0.60 for contact only (no account → review)', () => {
    const matches: EntityMatch[] = [
      makeMatch({ entityType: 'contact', entityId: 'c1', confidence: 0.95 }),
    ];

    const result = scorer.score(matches);

    expect(result.overallConfidence).toBe(0.60);
    expect(result.requiresReview).toBe(true);
    expect(result.reviewReason).toContain('no associated account');
  });

  it('returns 0.50 for ambiguous (multiple accounts → review)', () => {
    const matches: EntityMatch[] = [
      makeMatch({ entityType: 'account', entityId: 'a1', matchField: 'emailaddress1-domain', confidence: 0.70 }),
      makeMatch({ entityType: 'account', entityId: 'a2', matchField: 'websiteurl', confidence: 0.60 }),
    ];

    const result = scorer.score(matches);

    expect(result.overallConfidence).toBe(0.50);
    expect(result.requiresReview).toBe(true);
    expect(result.accountMatch).toBeNull(); // ambiguous — don't pick one
    expect(result.reviewReason).toContain('Ambiguous');
  });

  it('returns 0 confidence with review for no matches', () => {
    const result = scorer.score([]);

    expect(result.overallConfidence).toBe(0);
    expect(result.requiresReview).toBe(true);
    expect(result.accountMatch).toBeNull();
    expect(result.contactMatches).toHaveLength(0);
    expect(result.reviewReason).toContain('No entity matches');
  });

  it('respects custom review threshold', () => {
    const strictScorer = createConfidenceScorer({ reviewThreshold: 0.90 });

    const matches: EntityMatch[] = [
      makeMatch({ entityType: 'account', entityId: 'a1', matchField: 'emailaddress1-domain', confidence: 0.70 }),
      makeMatch({ entityType: 'contact', entityId: 'c1', confidence: 0.95 }),
    ];

    const result = strictScorer.score(matches);

    // 0.80 is below the 0.90 threshold
    expect(result.overallConfidence).toBe(0.80);
    expect(result.requiresReview).toBe(true);
  });

  it('does not treat same account from multiple contacts as ambiguous', () => {
    const matches: EntityMatch[] = [
      makeMatch({ entityType: 'contact', entityId: 'c1', confidence: 0.95 }),
      makeMatch({ entityType: 'contact', entityId: 'c2', confidence: 0.95 }),
      makeMatch({ entityType: 'account', entityId: 'a1', matchField: 'contact-parent', confidence: 0.95 }),
      makeMatch({ entityType: 'account', entityId: 'a1', matchField: 'emailaddress1-domain', confidence: 0.70 }),
    ];

    const result = scorer.score(matches);

    // Same account (a1) from different paths → not ambiguous
    expect(result.overallConfidence).toBe(0.95);
    expect(result.requiresReview).toBe(false);
    expect(result.contactMatches).toHaveLength(2);
  });
});
