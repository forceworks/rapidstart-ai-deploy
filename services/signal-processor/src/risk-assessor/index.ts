/**
 * Risk Assessor — evaluates opportunities against multiple risk signals
 * and produces an overall risk level with actionable recommendations.
 *
 * Risk factors considered:
 *   - Activity gap: days since last signal vs stage threshold
 *   - Engagement decline: score trend is decreasing or inactive
 *   - New stakeholder: unknown participants appeared in known account
 *   - Negative sentiment: recent meeting sentiment was negative
 *
 * Risk levels:
 *   - critical: 3+ high-severity factors OR activity gap > 2x threshold
 *   - high: 2+ factors with at least one high-severity
 *   - medium: 1-2 factors, none critical
 *   - low: no risk factors
 */

import { type DataverseClient } from '../shared/dataverse-client.js';
import { type Logger } from '../shared/logger.js';
import {
  type RiskAssessmentResult,
  type RiskFactor,
  type ActivityGapAlert,
  type EngagementScore,
} from '../shared/types.js';

export interface RiskAssessorService {
  /** Assess risk for a single opportunity */
  assess(opportunityId: string): Promise<RiskAssessmentResult>;
  /** Flag an at-risk opportunity via fw_FlagAtRisk Custom API */
  flagAtRisk(assessment: RiskAssessmentResult): Promise<FlagAtRiskResponse>;
}

export interface FlagAtRiskRequest {
  opportunityid: string;
  riskreason: string;
  risklevel: string;
  riskfactors: string;
  signalsource: string;
}

export interface FlagAtRiskResponse {
  success: boolean;
  message: string;
}

interface OpportunityRecord {
  opportunityid: string;
  name: string;
  stepname?: string;
  salesstagecode?: number;
  fw_engagementscore?: number;
  fw_engagementtrend?: number;
  fw_lastsignaldate?: string;
  fw_signalcount?: number;
  _parentaccountid_value?: string;
}

interface RecentAppointment {
  activityid: string;
  fw_sentiment?: number;
  fw_aisummary?: string;
  scheduledstart: string;
}

interface StakeholderOccurrence {
  fw_stakeholderoccurrenceid: string;
  fw_email: string;
  fw_count: number;
}

/**
 * Determine the overall risk level from a collection of risk factors.
 */
export function calculateRiskLevel(
  factors: RiskFactor[]
): 'low' | 'medium' | 'high' | 'critical' {
  if (factors.length === 0) return 'low';

  const highCount = factors.filter((f) => f.severity === 'high').length;

  if (highCount >= 3) return 'critical';
  if (highCount >= 2) return 'critical';
  if (highCount >= 1 && factors.length >= 2) return 'high';
  if (highCount >= 1) return 'high';
  if (factors.length >= 2) return 'medium';
  return 'medium';
}

/**
 * Generate a recommendation based on the risk factors present.
 */
export function generateRecommendation(factors: RiskFactor[]): string {
  if (factors.length === 0) return 'Opportunity is healthy — no action needed.';

  const types = new Set(factors.map((f) => f.type));
  const parts: string[] = [];

  if (types.has('activity-gap')) {
    parts.push('Schedule a meeting or check-in with the customer');
  }
  if (types.has('engagement-decline')) {
    parts.push('Review account engagement and re-engage key contacts');
  }
  if (types.has('new-stakeholder')) {
    parts.push('Add newly discovered stakeholders as CRM contacts');
  }
  if (types.has('sentiment-negative')) {
    parts.push('Review recent meeting notes for concerns to address');
  }

  return parts.join('. ') + '.';
}

export function createRiskAssessor(
  dataverseClient: DataverseClient,
  logger: Logger
): RiskAssessorService {
  return {
    async assess(opportunityId: string): Promise<RiskAssessmentResult> {
      const startTime = Date.now();
      const factors: RiskFactor[] = [];

      try {
        // Fetch opportunity details
        const opp = await dataverseClient.getById<OpportunityRecord>(
          'opportunities',
          opportunityId,
          ['opportunityid', 'name', 'stepname', 'salesstagecode', 'fw_engagementscore', 'fw_engagementtrend', 'fw_lastsignaldate', 'fw_signalcount']
        );

        const now = new Date();

        // ── Factor 1: Activity gap ──
        if (opp.fw_lastsignaldate) {
          const lastDate = new Date(opp.fw_lastsignaldate);
          const daysSince = Math.floor(
            (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
          );

          // Use stage-appropriate threshold
          const { getThresholdForStage } = await import('../activity-gap-detector/index.js');
          const threshold = getThresholdForStage(opp.stepname, opp.salesstagecode);

          if (daysSince > threshold) {
            const severity = daysSince > threshold * 2 ? 'high' : 'medium';
            factors.push({
              type: 'activity-gap',
              severity,
              description: `No activity for ${daysSince} days (threshold: ${threshold} days for ${opp.stepname || 'current'} stage)`,
              data: {
                daysSinceLastSignal: String(daysSince),
                threshold: String(threshold),
                stage: opp.stepname || 'unknown',
              },
            });
          }
        } else if ((opp.fw_signalcount || 0) === 0) {
          factors.push({
            type: 'activity-gap',
            severity: 'medium',
            description: 'No AI-captured activity detected for this opportunity',
            data: { daysSinceLastSignal: '999', threshold: '14' },
          });
        }

        // ── Factor 2: Engagement decline ──
        const trendMap: Record<number, string> = {
          1: 'increasing', 2: 'stable', 3: 'decreasing', 4: 'inactive',
        };
        const trend = trendMap[opp.fw_engagementtrend || 4] || 'inactive';

        if (trend === 'decreasing') {
          factors.push({
            type: 'engagement-decline',
            severity: 'medium',
            description: `Engagement score is declining (current: ${Math.round((opp.fw_engagementscore || 0) * 100)}%)`,
            data: {
              score: String(opp.fw_engagementscore || 0),
              trend,
            },
          });
        } else if (trend === 'inactive') {
          factors.push({
            type: 'engagement-decline',
            severity: 'high',
            description: `Account engagement is inactive (score: ${Math.round((opp.fw_engagementscore || 0) * 100)}%)`,
            data: {
              score: String(opp.fw_engagementscore || 0),
              trend,
            },
          });
        }

        // ── Factor 3: Negative sentiment in recent meetings ──
        try {
          const recentAppointments = await dataverseClient.get<RecentAppointment>(
            'appointments',
            `$filter=_regardingobjectid_value eq ${opportunityId} and fw_aisource eq true and fw_sentiment ne null&$select=activityid,fw_sentiment,fw_aisummary,scheduledstart&$orderby=scheduledstart desc&$top=3`
          );

          const negativeCount = recentAppointments.filter(
            (a) => a.fw_sentiment === 3 // 3 = negative
          ).length;

          if (negativeCount >= 2) {
            factors.push({
              type: 'sentiment-negative',
              severity: 'high',
              description: `${negativeCount} of the last ${recentAppointments.length} meetings had negative sentiment`,
              data: { negativeCount: String(negativeCount) },
            });
          } else if (negativeCount === 1) {
            factors.push({
              type: 'sentiment-negative',
              severity: 'medium',
              description: 'Recent meeting had negative sentiment',
              data: { negativeCount: '1' },
            });
          }
        } catch {
          // Non-critical — skip sentiment check
        }

        // ── Factor 4: New stakeholders in known account ──
        if (opp._parentaccountid_value) {
          try {
            const recentStakeholders = await dataverseClient.get<StakeholderOccurrence>(
              'fw_stakeholderoccurrences',
              `$filter=_fw_suggestedaccountid_value eq ${opp._parentaccountid_value} and fw_count ge 2&$select=fw_stakeholderoccurrenceid,fw_email,fw_count&$top=10`
            );

            if (recentStakeholders.length >= 3) {
              factors.push({
                type: 'new-stakeholder',
                severity: 'medium',
                description: `${recentStakeholders.length} unknown stakeholders detected in this account — possible organizational changes`,
                data: {
                  stakeholderCount: String(recentStakeholders.length),
                  emails: recentStakeholders.map((s) => s.fw_email).join(', '),
                },
              });
            }
          } catch {
            // Non-critical — skip stakeholder check
          }
        }

        const riskLevel = calculateRiskLevel(factors);
        const recommendation = generateRecommendation(factors);

        const durationMs = Date.now() - startTime;
        logger.info('Risk assessment complete', {
          opportunityId,
          riskLevel,
          factorCount: String(factors.length),
          durationMs: String(durationMs),
        });

        return {
          opportunityId,
          isAtRisk: factors.length > 0,
          riskFactors: factors,
          overallRiskLevel: riskLevel,
          recommendation,
        };
      } catch (error) {
        logger.error('Risk assessment failed', {
          opportunityId,
          error: String(error),
        });

        return {
          opportunityId,
          isAtRisk: false,
          riskFactors: [],
          overallRiskLevel: 'low',
          recommendation: 'Unable to assess risk — check system logs.',
        };
      }
    },

    async flagAtRisk(assessment: RiskAssessmentResult): Promise<FlagAtRiskResponse> {
      if (!assessment.isAtRisk) {
        return { success: true, message: 'Opportunity is not at risk — no action taken.' };
      }

      const request: FlagAtRiskRequest = {
        opportunityid: assessment.opportunityId,
        riskreason: assessment.recommendation,
        risklevel: assessment.overallRiskLevel,
        riskfactors: JSON.stringify(assessment.riskFactors),
        signalsource: 'activity-gap-detector',
      };

      logger.info('Dispatching fw_FlagAtRisk', {
        opportunityId: assessment.opportunityId,
        riskLevel: assessment.overallRiskLevel,
        factorCount: String(assessment.riskFactors.length),
      });

      try {
        const response = await dataverseClient.executeAction<FlagAtRiskRequest, FlagAtRiskResponse>(
          'fw_FlagAtRisk',
          request
        );

        logger.info('Opportunity flagged as at-risk', {
          opportunityId: assessment.opportunityId,
          success: String(response.success),
        });

        return response;
      } catch (error) {
        logger.error('Failed to flag opportunity at-risk', {
          opportunityId: assessment.opportunityId,
          error: String(error),
        });
        return { success: false, message: String(error) };
      }
    },
  };
}
