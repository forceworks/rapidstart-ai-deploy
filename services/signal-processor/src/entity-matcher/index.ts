/**
 * Entity Matcher — looks up Accounts and Contacts in Dataverse
 * by matching participant email addresses.
 *
 * Matching strategy (confidence scores):
 *   Contact exact email  → 0.95
 *   Account email domain → 0.70
 *   Account website      → 0.60
 */

import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';
import { type Signal, type EntityMatch } from '../shared/types.js';

export interface EntityMatcherService {
  /** Find account/contact matches for all external participants in a signal */
  matchEntities(signal: Signal): Promise<EntityMatch[]>;
}

interface DataverseContact {
  contactid: string;
  fullname: string;
  emailaddress1: string;
  _parentcustomerid_value?: string;
}

interface DataverseAccount {
  accountid: string;
  name: string;
  emailaddress1?: string;
  websiteurl?: string;
}

/**
 * Extract the domain portion from an email address.
 * Returns lowercase domain or null if invalid.
 */
export function extractDomain(email: string): string | null {
  const parts = email.toLowerCase().trim().split('@');
  if (parts.length !== 2 || !parts[1]) return null;
  return parts[1];
}

/**
 * Determine if an email domain is a generic/free provider
 * (and thus should not be used for account matching).
 */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'live.com', 'msn.com', 'protonmail.com', 'mail.com',
  'zoho.com', 'yandex.com', 'gmx.com', 'fastmail.com',
]);

export function isFreeEmailDomain(domain: string): boolean {
  return FREE_EMAIL_DOMAINS.has(domain.toLowerCase());
}

/**
 * Normalize a website URL to a bare domain for matching.
 * e.g. "https://www.company.com/about" → "company.com"
 */
export function normalizeWebsiteDomain(url: string): string | null {
  try {
    let cleaned = url.trim().toLowerCase();
    if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
      cleaned = 'https://' + cleaned;
    }
    const parsed = new URL(cleaned);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function createEntityMatcher(
  dataverseClient: DataverseClient,
  logger: Logger
): EntityMatcherService {
  return {
    async matchEntities(signal: Signal): Promise<EntityMatch[]> {
      const startTime = Date.now();
      const matches: EntityMatch[] = [];
      const seenAccountIds = new Set<string>();
      const seenContactIds = new Set<string>();

      // Collect unique external email domains for account lookup
      const domainToEmails = new Map<string, string[]>();

      for (const participant of signal.participants) {
        const email = participant.email.toLowerCase();
        const domain = extractDomain(email);
        if (!domain) continue;

        // --- Contact match: exact email lookup ---
        try {
          const contacts = await dataverseClient.get<DataverseContact>(
            'contacts',
            `$filter=emailaddress1 eq '${email}'&$select=contactid,fullname,emailaddress1,_parentcustomerid_value&$top=1`
          );

          if (contacts.length > 0) {
            const contact = contacts[0];
            if (!seenContactIds.has(contact.contactid)) {
              seenContactIds.add(contact.contactid);
              matches.push({
                entityType: 'contact',
                entityId: contact.contactid,
                entityName: contact.fullname || email,
                matchField: 'emailaddress1',
                matchValue: email,
                confidence: 0.95,
              });

              // If the contact has a parent account, add it as a match too
              if (contact._parentcustomerid_value && !seenAccountIds.has(contact._parentcustomerid_value)) {
                seenAccountIds.add(contact._parentcustomerid_value);
                try {
                  const account = await dataverseClient.getById<DataverseAccount>(
                    'accounts',
                    contact._parentcustomerid_value,
                    ['accountid', 'name']
                  );
                  matches.push({
                    entityType: 'account',
                    entityId: account.accountid,
                    entityName: account.name,
                    matchField: 'contact-parent',
                    matchValue: email,
                    confidence: 0.95,
                  });
                } catch {
                  logger.warn('Failed to fetch parent account for contact', {
                    contactId: contact.contactid,
                    parentAccountId: contact._parentcustomerid_value,
                  });
                }
              }
            }
          }
        } catch (error) {
          logger.warn('Contact lookup failed', { email, error: String(error) });
        }

        // Collect domains for batch account lookup (skip free email providers)
        if (!isFreeEmailDomain(domain)) {
          if (!domainToEmails.has(domain)) {
            domainToEmails.set(domain, []);
          }
          domainToEmails.get(domain)!.push(email);
        }
      }

      // --- Account match: email domain + website domain ---
      for (const [domain, emails] of domainToEmails) {
        // Skip if we already found this account via contact parent
        try {
          // Match by account email domain
          const emailDomainFilter = `contains(emailaddress1, '@${domain}')`;
          const emailAccounts = await dataverseClient.get<DataverseAccount>(
            'accounts',
            `$filter=${emailDomainFilter}&$select=accountid,name,emailaddress1&$top=5`
          );

          for (const account of emailAccounts) {
            if (!seenAccountIds.has(account.accountid)) {
              seenAccountIds.add(account.accountid);
              matches.push({
                entityType: 'account',
                entityId: account.accountid,
                entityName: account.name,
                matchField: 'emailaddress1-domain',
                matchValue: domain,
                confidence: 0.70,
              });
            }
          }

          // Match by website domain
          const websiteAccounts = await dataverseClient.get<DataverseAccount>(
            'accounts',
            `$filter=contains(websiteurl, '${domain}')&$select=accountid,name,websiteurl&$top=5`
          );

          for (const account of websiteAccounts) {
            // Verify the website domain actually matches (contains is broad)
            const websiteDomain = normalizeWebsiteDomain(account.websiteurl || '');
            if (websiteDomain === domain && !seenAccountIds.has(account.accountid)) {
              seenAccountIds.add(account.accountid);
              matches.push({
                entityType: 'account',
                entityId: account.accountid,
                entityName: account.name,
                matchField: 'websiteurl',
                matchValue: domain,
                confidence: 0.60,
              });
            }
          }
        } catch (error) {
          logger.warn('Account domain lookup failed', { domain, error: String(error) });
        }
      }

      const durationMs = Date.now() - startTime;
      logger.info('Entity matching complete', {
        signalId: signal.id,
        participantCount: String(signal.participants.length),
        matchCount: String(matches.length),
        durationMs: String(durationMs),
      });

      return matches;
    },
  };
}
