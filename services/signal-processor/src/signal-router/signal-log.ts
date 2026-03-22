/**
 * Signal Log service — CRUD for fw_signallog table.
 * Provides idempotency checks via graphResourceId lookup.
 */

import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';
import { type SignalLogEntry } from '../shared/types.js';

export interface SignalLogService {
  /** Check if a signal with this graphResourceId has already been processed */
  exists(graphResourceId: string): Promise<boolean>;
  /** Create a new signal log entry */
  create(entry: SignalLogEntry): Promise<string>;
  /** Update the status of an existing signal log entry */
  updateStatus(signalId: string, status: string, message?: string): Promise<void>;
}

interface SignalLogRecord {
  fw_signallogid: string;
  fw_signalid: string;
  fw_graphresourceid: string;
  fw_signaltype: number;
  fw_status: number;
  fw_confidencescore: number;
  fw_processingdurationms: number;
  fw_errormessage: string;
  fw_useremail: string;
}

const SIGNAL_TYPE_MAP: Record<string, number> = {
  meeting: 1,
  email: 2,
  call: 3,
};

const STATUS_MAP: Record<string, number> = {
  received: 1,
  processing: 2,
  processed: 3,
  'queued-for-review': 4,
  'governance-denied': 5,
  failed: 6,
  'dead-lettered': 7,
};

export function createSignalLogService(
  dataverseClient: DataverseClient,
  logger: Logger
): SignalLogService {
  return {
    async exists(graphResourceId: string): Promise<boolean> {
      const filter = `fw_graphresourceid eq '${graphResourceId}'`;
      const records = await dataverseClient.get<SignalLogRecord>(
        'fw_signallogs',
        `$filter=${filter}&$top=1&$select=fw_signallogid`
      );
      return records.length > 0;
    },

    async create(entry: SignalLogEntry): Promise<string> {
      const record: Record<string, unknown> = {
        fw_signalid: entry.signalId,
        fw_graphresourceid: entry.graphResourceId,
        fw_signaltype: SIGNAL_TYPE_MAP[entry.signalType] || 1,
        fw_status: STATUS_MAP[entry.status] || 1,
        fw_confidencescore: entry.confidence,
        fw_processingdurationms: entry.processingDurationMs,
        fw_useremail: entry.userEmail || '',
      };

      if (entry.errorMessage) {
        record.fw_errormessage = entry.errorMessage;
      }
      if (entry.signalPayload) {
        record.fw_signalpayload = entry.signalPayload;
      }
      if (entry.accountId) {
        record['fw_accountid@odata.bind'] = `/accounts(${entry.accountId})`;
      }

      const id = await dataverseClient.create('fw_signallogs', record);
      logger.trackSignal(entry.signalId, 'logged', { status: entry.status });
      return id;
    },

    async updateStatus(signalId: string, status: string, message?: string): Promise<void> {
      // Find the record by signalId
      const filter = `fw_signalid eq '${signalId}'`;
      const records = await dataverseClient.get<SignalLogRecord>(
        'fw_signallogs',
        `$filter=${filter}&$top=1&$select=fw_signallogid`
      );

      if (records.length === 0) {
        logger.warn('Signal log record not found for status update', { signalId, status });
        return;
      }

      const updateData: Record<string, unknown> = {
        fw_status: STATUS_MAP[status] || 1,
      };

      if (message) {
        updateData.fw_errormessage = message;
      }

      await dataverseClient.update('fw_signallogs', records[0].fw_signallogid, updateData);
      logger.trackSignal(signalId, 'status-updated', { status });
    },
  };
}
