/**
 * Usage Governance — pre-spend check before any OpenAI call.
 * Enforces per-tenant, per-user, per-month usage limits based on license tier.
 */

import { type DataverseClient } from './dataverse-client.js';
import { type Logger } from './logger.js';
import { type AppConfig } from './config.js';
import { type UsageCheckResult } from './types.js';

/** Default tier limits (overridable by fw_aitenantconfig) */
const TIER_LIMITS: Record<string, number> = {
  starter: 100,
  pro: 1000,
  private: 0, // 0 = use config cap
};

export interface UsageGovernanceService {
  checkUsage(tenantId: string, userId: string): Promise<UsageCheckResult>;
  recordUsage(tenantId: string, userId: string): Promise<void>;
}

interface UsageCounterRecord {
  fw_usagecounterid?: string;
  fw_name: string;
  fw_tenantid: string;
  fw_userid: string;
  fw_period: string;
  fw_count: number;
}

function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function createUsageGovernanceService(
  dataverseClient: DataverseClient,
  config: AppConfig['governance'],
  logger: Logger
): UsageGovernanceService {
  function getLimit(): number {
    if (config.licenseTier === 'private') {
      return config.monthlyCapPerUser; // 0 = unlimited
    }
    return TIER_LIMITS[config.licenseTier] || TIER_LIMITS.pro;
  }

  async function getCounter(tenantId: string, userId: string): Promise<UsageCounterRecord | null> {
    const period = getCurrentPeriod();
    const filter = `fw_tenantid eq '${tenantId}' and fw_userid eq '${userId}' and fw_period eq '${period}'`;
    const records = await dataverseClient.get<UsageCounterRecord>('fw_usagecounters', `$filter=${filter}&$top=1`);
    return records.length > 0 ? records[0] : null;
  }

  return {
    async checkUsage(tenantId: string, userId: string): Promise<UsageCheckResult> {
      const limit = getLimit();

      // Unlimited (private tier with cap = 0)
      if (limit === 0) {
        return {
          allowed: true,
          currentCount: 0,
          limit: 0,
          licenseTier: config.licenseTier,
        };
      }

      const counter = await getCounter(tenantId, userId);
      const currentCount = counter?.fw_count || 0;

      if (currentCount >= limit) {
        logger.warn('Usage limit reached', {
          tenantId,
          userId,
          currentCount: String(currentCount),
          limit: String(limit),
          tier: config.licenseTier,
        });

        return {
          allowed: false,
          currentCount,
          limit,
          licenseTier: config.licenseTier,
          reason: `Monthly limit of ${limit} reached for ${config.licenseTier} tier (current: ${currentCount})`,
        };
      }

      return {
        allowed: true,
        currentCount,
        limit,
        licenseTier: config.licenseTier,
      };
    },

    async recordUsage(tenantId: string, userId: string): Promise<void> {
      const period = getCurrentPeriod();
      const counter = await getCounter(tenantId, userId);

      if (counter && counter.fw_usagecounterid) {
        // Increment existing counter
        await dataverseClient.update('fw_usagecounters', counter.fw_usagecounterid, {
          fw_count: counter.fw_count + 1,
          fw_lastupdated: new Date().toISOString(),
        });
      } else {
        // Create new counter
        await dataverseClient.create('fw_usagecounters', {
          fw_name: `${tenantId}_${userId}_${period}`,
          fw_tenantid: tenantId,
          fw_userid: userId,
          fw_period: period,
          fw_count: 1,
          fw_lastupdated: new Date().toISOString(),
        });
      }

      logger.info('Usage recorded', { tenantId, userId, period });
    },
  };
}
