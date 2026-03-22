/**
 * Stakeholder Detector — identifies unknown participants (not in CRM)
 * and flags new stakeholders in known accounts.
 *
 * Phase 2 component: surfaces discovery opportunities for salespeople.
 * Unknown participants with emails matching a known account domain
 * trigger "new stakeholder in known account" alerts.
 */

import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';
import {
  type Signal,
  type EntityMatch,
  type ConfidenceResult,
  type UnknownStakeholder,
  type StakeholderDetectionResult,
} from '../shared/types.js';
import { extractDomain, isFreeEmailDomain } from '../entity-matcher/index.js';

export interface StakeholderDetectorService {
  /** Detect unknown stakeholders from signal participants */
  detect(
    signal: Signal,
    confidenceResult: ConfidenceResult
  ): Promise<StakeholderDetectionResult>;
}

interface OccurrenceRecord {
  fw_stakeholderoccurrenceid?: string;
  fw_email: string;
  fw_count: number;
  fw_lastseen: string;
  fw_suggestedaccountid?: string;
}

export function createStakeholderDetector(
  dataverseClient: DataverseClient,
  logger: Logger
): StakeholderDetectorService {
  /**
   * Look up whether an email belongs to a known contact.
   */
  async function isKnownContact(email: string): Promise<EntityMatch | null> {
    try {
      const contacts = await dataverseClient.get<{
        contactid: string;
        fullname: string;
        emailaddress1: string;
      }>(
        'contacts',
        `$filter=emailaddress1 eq '${email.toLowerCase()}'&$select=contactid,fullname,emailaddress1&$top=1`
      );

      if (contacts.length > 0) {
        return {
          entityType: 'contact',
          entityId: contacts[0].contactid,
          entityName: contacts[0].fullname || email,
          matchField: 'emailaddress1',
          matchValue: email,
          confidence: 0.95,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Find if a domain maps to a known account (via website or email domain).
   */
  async function findAccountByDomain(domain: string): Promise<{ id: string; name: string } | null> {
    try {
      const accounts = await dataverseClient.get<{
        accountid: string;
        name: string;
      }>(
        'accounts',
        `$filter=contains(emailaddress1, '@${domain}') or contains(websiteurl, '${domain}')&$select=accountid,name&$top=1`
      );

      if (accounts.length > 0) {
        return { id: accounts[0].accountid, name: accounts[0].name };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Track or increment occurrence count for an unknown stakeholder.
   * Returns the updated count.
   */
  async function trackOccurrence(
    email: string,
    accountId?: string
  ): Promise<number> {
    try {
      const records = await dataverseClient.get<OccurrenceRecord>(
        'fw_stakeholderoccurrences',
        `$filter=fw_email eq '${email.toLowerCase()}'&$top=1`
      );

      if (records.length > 0 && records[0].fw_stakeholderoccurrenceid) {
        const newCount = records[0].fw_count + 1;
        await dataverseClient.update(
          'fw_stakeholderoccurrences',
          records[0].fw_stakeholderoccurrenceid,
          {
            fw_count: newCount,
            fw_lastseen: new Date().toISOString(),
          }
        );
        return newCount;
      }

      const data: Record<string, unknown> = {
        fw_email: email.toLowerCase(),
        fw_count: 1,
        fw_lastseen: new Date().toISOString(),
        fw_name: email.toLowerCase(),
      };

      if (accountId) {
        data['fw_suggestedaccountid@odata.bind'] = `/accounts(${accountId})`;
      }

      await dataverseClient.create('fw_stakeholderoccurrences', data);
      return 1;
    } catch (error) {
      logger.warn('Failed to track stakeholder occurrence', {
        email,
        error: String(error),
      });
      return 1;
    }
  }

  return {
    async detect(
      signal: Signal,
      confidenceResult: ConfidenceResult
    ): Promise<StakeholderDetectionResult> {
      const startTime = Date.now();
      const knownContacts: EntityMatch[] = [];
      const unknownStakeholders: UnknownStakeholder[] = [];
      let newStakeholderInKnownAccount = false;

      // Build a set of already-matched contact emails from entity matching
      const alreadyMatchedEmails = new Set<string>(
        confidenceResult.contactMatches.map((m) => m.matchValue.toLowerCase())
      );

      for (const participant of signal.participants) {
        const email = participant.email.toLowerCase();

        // Skip the signal owner (they're the CRM user, not an external stakeholder)
        if (email === signal.userEmail.toLowerCase()) continue;

        // Skip if already matched in entity matching phase
        if (alreadyMatchedEmails.has(email)) {
          // Add to known contacts from confidence result
          const existing = confidenceResult.contactMatches.find(
            (m) => m.matchValue.toLowerCase() === email
          );
          if (existing) knownContacts.push(existing);
          continue;
        }

        // Check if this participant is a known contact
        const contactMatch = await isKnownContact(email);
        if (contactMatch) {
          knownContacts.push(contactMatch);
          continue;
        }

        // Unknown participant — check if their domain maps to a known account
        const domain = extractDomain(email);
        if (!domain || isFreeEmailDomain(domain)) {
          // Free email domain — still track but no account suggestion
          const count = await trackOccurrence(email);
          unknownStakeholders.push({
            email,
            displayName: participant.displayName,
            domain: domain || 'unknown',
            occurrenceCount: count,
          });
          continue;
        }

        // Check if domain belongs to a known account
        const matchedAccount = await findAccountByDomain(domain);
        const count = await trackOccurrence(email, matchedAccount?.id);

        const stakeholder: UnknownStakeholder = {
          email,
          displayName: participant.displayName,
          domain,
          occurrenceCount: count,
        };

        if (matchedAccount) {
          stakeholder.suggestedAccountId = matchedAccount.id;
          stakeholder.suggestedAccountName = matchedAccount.name;
          newStakeholderInKnownAccount = true;
        }

        unknownStakeholders.push(stakeholder);
      }

      const durationMs = Date.now() - startTime;
      logger.info('Stakeholder detection complete', {
        signalId: signal.id,
        knownCount: String(knownContacts.length),
        unknownCount: String(unknownStakeholders.length),
        newInKnownAccount: String(newStakeholderInKnownAccount),
        durationMs: String(durationMs),
      });

      return {
        knownContacts,
        unknownStakeholders,
        newStakeholderInKnownAccount,
      };
    },
  };
}
