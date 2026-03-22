/**
 * Confidence Scorer — aggregates entity match scores
 * and determines whether a signal can be auto-processed
 * or needs human review.
 *
 * Scoring rules:
 *   Account + Contact match       → 0.95 (auto-process)
 *   Account domain + Contact      → 0.80 (auto-process)
 *   Account (domain or website)   → 0.70 (auto-process at default threshold)
 *   Contact only (no account)     → 0.60 (review)
 *   Ambiguous (multiple accounts) → 0.50 (review)
 *   No match                      → 0.00 (review)
 *
 * Default threshold: 0.70 — below this goes to review queue.
 */

import { type EntityMatch, type ConfidenceResult } from '../shared/types.js';

const DEFAULT_REVIEW_THRESHOLD = 0.70;

export interface ConfidenceScorerOptions {
  /** Minimum confidence to auto-process. Below this → review queue. */
  reviewThreshold?: number;
}

export interface ConfidenceScorerService {
  /** Score a set of entity matches and determine processing route */
  score(matches: EntityMatch[]): ConfidenceResult;
}

export function createConfidenceScorer(
  options?: ConfidenceScorerOptions
): ConfidenceScorerService {
  const threshold = options?.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;

  return {
    score(matches: EntityMatch[]): ConfidenceResult {
      const accountMatches = matches.filter((m) => m.entityType === 'account');
      const contactMatches = matches.filter((m) => m.entityType === 'contact');

      // No matches at all
      if (matches.length === 0) {
        return {
          overallConfidence: 0,
          accountMatch: null,
          contactMatches: [],
          requiresReview: true,
          reviewReason: 'No entity matches found',
        };
      }

      // Ambiguous: multiple distinct accounts found
      const uniqueAccountIds = new Set(accountMatches.map((a) => a.entityId));
      if (uniqueAccountIds.size > 1) {
        return {
          overallConfidence: 0.50,
          accountMatch: null, // ambiguous — don't pick one
          contactMatches,
          requiresReview: true,
          reviewReason: `Ambiguous: ${uniqueAccountIds.size} potential account matches`,
        };
      }

      // Determine best account match (highest confidence)
      const bestAccount = accountMatches.length > 0
        ? accountMatches.reduce((best, m) => m.confidence > best.confidence ? m : best)
        : null;

      let overallConfidence: number;

      if (bestAccount && contactMatches.length > 0) {
        // Account + Contact match
        if (bestAccount.matchField === 'contact-parent' || bestAccount.confidence >= 0.90) {
          overallConfidence = 0.95;
        } else {
          // Account domain/website + contact
          overallConfidence = 0.80;
        }
      } else if (bestAccount) {
        // Account only (domain or website match, no contact)
        overallConfidence = bestAccount.confidence; // 0.70 or 0.60
      } else if (contactMatches.length > 0) {
        // Contact only, no account
        overallConfidence = 0.60;
      } else {
        overallConfidence = 0;
      }

      const requiresReview = overallConfidence < threshold;
      let reviewReason: string | undefined;

      if (requiresReview) {
        if (contactMatches.length > 0 && !bestAccount) {
          reviewReason = 'Contact found but no associated account';
        } else if (overallConfidence === 0) {
          reviewReason = 'No entity matches found';
        } else {
          reviewReason = `Confidence ${overallConfidence.toFixed(2)} below threshold ${threshold.toFixed(2)}`;
        }
      }

      return {
        overallConfidence,
        accountMatch: bestAccount,
        contactMatches,
        requiresReview,
        reviewReason,
      };
    },
  };
}
