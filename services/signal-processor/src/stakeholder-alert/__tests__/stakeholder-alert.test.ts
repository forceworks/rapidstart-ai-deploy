import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStakeholderAlertService } from '../index.js';
import { type DataverseClient } from '../../shared/dataverse-client.js';
import { type Logger } from '../../shared/logger.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trackSignal: vi.fn(),
    trackDependency: vi.fn(),
  };
}

describe('createStakeholderAlertService', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it('generates org-change alert when 3+ unknowns in same account', async () => {
    const mockGet = vi.fn()
      // Occurrences with 2+ count
      .mockResolvedValueOnce([
        { fw_stakeholderoccurrenceid: 's1', fw_email: 'a@contoso.com', fw_count: 3, fw_lastseen: '2026-03-01', _fw_suggestedaccountid_value: 'acc-1' },
        { fw_stakeholderoccurrenceid: 's2', fw_email: 'b@contoso.com', fw_count: 2, fw_lastseen: '2026-03-02', _fw_suggestedaccountid_value: 'acc-1' },
        { fw_stakeholderoccurrenceid: 's3', fw_email: 'c@contoso.com', fw_count: 2, fw_lastseen: '2026-03-03', _fw_suggestedaccountid_value: 'acc-1' },
      ])
      // Existing alerts (none)
      .mockResolvedValueOnce([]);

    const mockGetById = vi.fn().mockResolvedValue({ name: 'Contoso Ltd' });
    const mockCreate = vi.fn().mockResolvedValue('alert-1');

    const client: DataverseClient = {
      get: mockGet,
      getById: mockGetById,
      executeAction: vi.fn(),
      create: mockCreate,
      update: vi.fn(),
    };

    const service = createStakeholderAlertService(client, mockLogger);
    const result = await service.scanAndAlert();

    expect(result.alertsGenerated).toBe(1);
    expect(result.alerts[0].alertType).toBe('org-change-signal');
    expect(result.alerts[0].stakeholderCount).toBe(3);
    expect(result.alerts[0].accountName).toBe('Contoso Ltd');
    expect(result.alerts[0].message).toContain('organizational changes');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('generates recurring-unknown alerts for individual stakeholders', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce([
        { fw_stakeholderoccurrenceid: 's1', fw_email: 'john@fabrikam.com', fw_displayname: 'John Doe', fw_count: 5, fw_lastseen: '2026-03-15', _fw_suggestedaccountid_value: 'acc-2' },
      ])
      .mockResolvedValueOnce([]); // no existing alerts

    const mockGetById = vi.fn().mockResolvedValue({ name: 'Fabrikam Inc' });
    const mockCreate = vi.fn().mockResolvedValue('alert-2');

    const client: DataverseClient = {
      get: mockGet,
      getById: mockGetById,
      executeAction: vi.fn(),
      create: mockCreate,
      update: vi.fn(),
    };

    const service = createStakeholderAlertService(client, mockLogger);
    const result = await service.scanAndAlert();

    expect(result.alertsGenerated).toBe(1);
    expect(result.alerts[0].alertType).toBe('recurring-unknown');
    expect(result.alerts[0].message).toContain('John Doe');
    expect(result.alerts[0].message).toContain('5 meetings');
    expect(result.alerts[0].maxOccurrences).toBe(5);
  });

  it('skips alerts that already exist', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce([
        { fw_stakeholderoccurrenceid: 's1', fw_email: 'x@test.com', fw_count: 3, fw_lastseen: '2026-03-10', _fw_suggestedaccountid_value: 'acc-3' },
      ])
      // Existing alerts — already has an alert for acc-3 type 1
      .mockResolvedValueOnce([
        { fw_stakeholderalertid: 'existing-1', fw_accountid: 'acc-3', fw_alerttype: 1 },
      ]);

    const mockGetById = vi.fn().mockResolvedValue({ name: 'TestCo' });
    const mockCreate = vi.fn().mockResolvedValue('alert-new');

    const client: DataverseClient = {
      get: mockGet,
      getById: mockGetById,
      executeAction: vi.fn(),
      create: mockCreate,
      update: vi.fn(),
    };

    const service = createStakeholderAlertService(client, mockLogger);
    const result = await service.scanAndAlert();

    // Alert is generated but not persisted (already exists)
    expect(result.alertsGenerated).toBe(1);
    expect(result.alertsPersisted).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns empty results when no occurrences found', async () => {
    const client: DataverseClient = {
      get: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const service = createStakeholderAlertService(client, mockLogger);
    const result = await service.scanAndAlert();

    expect(result.totalOccurrencesScanned).toBe(0);
    expect(result.alertsGenerated).toBe(0);
    expect(result.alerts).toHaveLength(0);
  });

  it('handles Dataverse failure gracefully', async () => {
    const client: DataverseClient = {
      get: vi.fn().mockRejectedValue(new Error('Dataverse unavailable')),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const service = createStakeholderAlertService(client, mockLogger);
    const result = await service.scanAndAlert();

    expect(result.totalOccurrencesScanned).toBe(0);
    expect(result.alertsGenerated).toBe(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
