import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUsageGovernanceService } from '../usage-governance.js';
import { type DataverseClient } from '../dataverse-client.js';
import { type Logger } from '../logger.js';
import { type AppConfig } from '../config.js';

describe('usage-governance', () => {
  let mockDataverseClient: DataverseClient;
  let mockLogger: Logger;

  beforeEach(() => {
    mockDataverseClient = {
      get: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      executeAction: vi.fn(),
      create: vi.fn().mockResolvedValue('new-id'),
      update: vi.fn().mockResolvedValue(undefined),
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trackSignal: vi.fn(),
      trackDependency: vi.fn(),
    };
  });

  describe('checkUsage', () => {
    it('allows when under limit (pro tier)', async () => {
      const config: AppConfig['governance'] = { licenseTier: 'pro', monthlyCapPerUser: 0 };
      vi.mocked(mockDataverseClient.get).mockResolvedValue([{ fw_count: 500 }]);

      const service = createUsageGovernanceService(mockDataverseClient, config, mockLogger);
      const result = await service.checkUsage('tenant-1', 'user-1');

      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(500);
      expect(result.limit).toBe(1000);
    });

    it('denies when at limit (starter tier)', async () => {
      const config: AppConfig['governance'] = { licenseTier: 'starter', monthlyCapPerUser: 0 };
      vi.mocked(mockDataverseClient.get).mockResolvedValue([{ fw_count: 100 }]);

      const service = createUsageGovernanceService(mockDataverseClient, config, mockLogger);
      const result = await service.checkUsage('tenant-1', 'user-1');

      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(100);
      expect(result.limit).toBe(100);
      expect(result.reason).toContain('Monthly limit of 100 reached');
    });

    it('allows unlimited for private tier with cap = 0', async () => {
      const config: AppConfig['governance'] = { licenseTier: 'private', monthlyCapPerUser: 0 };

      const service = createUsageGovernanceService(mockDataverseClient, config, mockLogger);
      const result = await service.checkUsage('tenant-1', 'user-1');

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(0);
    });

    it('enforces cap for private tier with cap > 0', async () => {
      const config: AppConfig['governance'] = { licenseTier: 'private', monthlyCapPerUser: 50 };
      vi.mocked(mockDataverseClient.get).mockResolvedValue([{ fw_count: 50 }]);

      const service = createUsageGovernanceService(mockDataverseClient, config, mockLogger);
      const result = await service.checkUsage('tenant-1', 'user-1');

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(50);
    });

    it('allows when no counter record exists (count = 0)', async () => {
      const config: AppConfig['governance'] = { licenseTier: 'pro', monthlyCapPerUser: 0 };
      vi.mocked(mockDataverseClient.get).mockResolvedValue([]);

      const service = createUsageGovernanceService(mockDataverseClient, config, mockLogger);
      const result = await service.checkUsage('tenant-1', 'user-1');

      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
    });
  });

  describe('recordUsage', () => {
    it('creates new counter when none exists', async () => {
      const config: AppConfig['governance'] = { licenseTier: 'pro', monthlyCapPerUser: 0 };
      vi.mocked(mockDataverseClient.get).mockResolvedValue([]);

      const service = createUsageGovernanceService(mockDataverseClient, config, mockLogger);
      await service.recordUsage('tenant-1', 'user-1');

      expect(mockDataverseClient.create).toHaveBeenCalledWith('fw_usagecounters', expect.objectContaining({
        fw_tenantid: 'tenant-1',
        fw_userid: 'user-1',
        fw_count: 1,
      }));
    });

    it('increments existing counter', async () => {
      const config: AppConfig['governance'] = { licenseTier: 'pro', monthlyCapPerUser: 0 };
      vi.mocked(mockDataverseClient.get).mockResolvedValue([{
        fw_usagecounterid: 'counter-1',
        fw_count: 5,
      }]);

      const service = createUsageGovernanceService(mockDataverseClient, config, mockLogger);
      await service.recordUsage('tenant-1', 'user-1');

      expect(mockDataverseClient.update).toHaveBeenCalledWith('fw_usagecounters', 'counter-1', expect.objectContaining({
        fw_count: 6,
      }));
    });
  });
});
