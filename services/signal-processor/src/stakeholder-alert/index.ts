/**
 * Stakeholder Alert Service — scans for new/recurring unknown stakeholders
 * in known accounts and surfaces alerts for salespeople.
 *
 * Alerts are generated when:
 *   - An unknown stakeholder appears 2+ times in a known account
 *   - Multiple unknown stakeholders cluster in the same account (org change signal)
 *
 * Alerts are persisted to fw_stakeholderalerts for dashboard/notification consumption.
 */

import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';

export interface StakeholderAlertService {
  /** Scan stakeholder occurrences and generate alerts */
  scanAndAlert(): Promise<StakeholderAlertScanResult>;
}

export interface StakeholderAlert {
  accountId: string;
  accountName: string;
  alertType: 'recurring-unknown' | 'org-change-signal';
  stakeholderEmails: string[];
  stakeholderCount: number;
  maxOccurrences: number;
  message: string;
}

export interface StakeholderAlertScanResult {
  totalOccurrencesScanned: number;
  alertsGenerated: number;
  alertsPersisted: number;
  alerts: StakeholderAlert[];
  durationMs: number;
}

interface OccurrenceRecord {
  fw_stakeholderoccurrenceid: string;
  fw_email: string;
  fw_displayname?: string;
  fw_count: number;
  fw_lastseen: string;
  _fw_suggestedaccountid_value?: string;
}

interface AccountNameRecord {
  accountid: string;
  name: string;
}

interface ExistingAlertRecord {
  fw_stakeholderalertid: string;
  fw_accountid: string;
  fw_alerttype: number;
}

/** Minimum occurrence count before generating an alert */
const MIN_OCCURRENCE_THRESHOLD = 2;

/** Minimum unknown stakeholders in one account to trigger org-change alert */
const ORG_CHANGE_THRESHOLD = 3;

export function createStakeholderAlertService(
  dataverseClient: DataverseClient,
  logger: Logger
): StakeholderAlertService {
  return {
    async scanAndAlert(): Promise<StakeholderAlertScanResult> {
      const startTime = Date.now();
      const alerts: StakeholderAlert[] = [];
      let persistedCount = 0;

      try {
        // Fetch all occurrences with 2+ sightings that have a suggested account
        const occurrences = await dataverseClient.get<OccurrenceRecord>(
          'fw_stakeholderoccurrences',
          `$filter=fw_count ge ${MIN_OCCURRENCE_THRESHOLD} and _fw_suggestedaccountid_value ne null&$select=fw_stakeholderoccurrenceid,fw_email,fw_displayname,fw_count,fw_lastseen,_fw_suggestedaccountid_value&$orderby=fw_count desc`
        );

        logger.info('Stakeholder alert scan started', {
          occurrenceCount: String(occurrences.length),
        });

        // Group by account
        const byAccount = new Map<string, OccurrenceRecord[]>();
        for (const occ of occurrences) {
          const accountId = occ._fw_suggestedaccountid_value!;
          const existing = byAccount.get(accountId) || [];
          existing.push(occ);
          byAccount.set(accountId, existing);
        }

        // Fetch existing open alerts to avoid duplicates
        const existingAlerts = await dataverseClient.get<ExistingAlertRecord>(
          'fw_stakeholderalerts',
          '$filter=fw_status eq 1&$select=fw_stakeholderalertid,fw_accountid,fw_alerttype'
        );
        const existingAlertKeys = new Set(
          existingAlerts.map((a) => `${a.fw_accountid}-${a.fw_alerttype}`)
        );

        // Generate alerts per account
        for (const [accountId, accountOccs] of byAccount) {
          // Look up account name
          let accountName = accountId;
          try {
            const account = await dataverseClient.getById<AccountNameRecord>(
              'accounts',
              accountId,
              ['name']
            );
            accountName = account.name;
          } catch {
            // Continue with ID as name
          }

          const emails = accountOccs.map((o) => o.fw_email);
          const maxCount = Math.max(...accountOccs.map((o) => o.fw_count));

          // Alert: Org change signal (many unknowns in same account)
          if (accountOccs.length >= ORG_CHANGE_THRESHOLD) {
            const alert: StakeholderAlert = {
              accountId,
              accountName,
              alertType: 'org-change-signal',
              stakeholderEmails: emails,
              stakeholderCount: accountOccs.length,
              maxOccurrences: maxCount,
              message: `${accountOccs.length} unknown stakeholders detected at ${accountName} — possible organizational changes. Consider adding them as contacts.`,
            };
            alerts.push(alert);

            if (!existingAlertKeys.has(`${accountId}-2`)) {
              try {
                await persistAlert(alert);
                persistedCount++;
              } catch (error) {
                logger.warn('Failed to persist org-change alert', {
                  accountId,
                  error: String(error),
                });
              }
            }
          } else {
            // Alert: Recurring unknown stakeholder(s)
            for (const occ of accountOccs) {
              const alert: StakeholderAlert = {
                accountId,
                accountName,
                alertType: 'recurring-unknown',
                stakeholderEmails: [occ.fw_email],
                stakeholderCount: 1,
                maxOccurrences: occ.fw_count,
                message: `${occ.fw_displayname || occ.fw_email} has appeared in ${occ.fw_count} meetings with ${accountName} but is not a CRM contact.`,
              };
              alerts.push(alert);

              if (!existingAlertKeys.has(`${accountId}-1`)) {
                try {
                  await persistAlert(alert);
                  persistedCount++;
                } catch (error) {
                  logger.warn('Failed to persist recurring-unknown alert', {
                    accountId,
                    email: occ.fw_email,
                    error: String(error),
                  });
                }
              }
            }
          }
        }

        const durationMs = Date.now() - startTime;
        logger.info('Stakeholder alert scan complete', {
          occurrencesScanned: String(occurrences.length),
          alertsGenerated: String(alerts.length),
          alertsPersisted: String(persistedCount),
          durationMs: String(durationMs),
        });

        return {
          totalOccurrencesScanned: occurrences.length,
          alertsGenerated: alerts.length,
          alertsPersisted: persistedCount,
          alerts,
          durationMs,
        };
      } catch (error) {
        logger.error('Stakeholder alert scan failed', {
          error: String(error),
          durationMs: String(Date.now() - startTime),
        });
        return {
          totalOccurrencesScanned: 0,
          alertsGenerated: 0,
          alertsPersisted: 0,
          alerts: [],
          durationMs: Date.now() - startTime,
        };
      }
    },
  };

  async function persistAlert(alert: StakeholderAlert): Promise<void> {
    await dataverseClient.create('fw_stakeholderalerts', {
      fw_name: alert.message.slice(0, 200),
      ['fw_accountid@odata.bind']: `/accounts(${alert.accountId})`,
      fw_alerttype: alert.alertType === 'recurring-unknown' ? 1 : 2,
      fw_stakeholderemails: alert.stakeholderEmails.join('; '),
      fw_stakeholdercount: alert.stakeholderCount,
      fw_maxoccurrences: alert.maxOccurrences,
      fw_message: alert.message,
      fw_status: 1, // Open
      fw_createdon: new Date().toISOString(),
    });
  }
}
