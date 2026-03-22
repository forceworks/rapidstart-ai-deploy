/**
 * Core domain types for RapidStart AI signal processing.
 * Every service references these types — keep them stable.
 */

/** The canonical signal shape after Graph webhook parsing */
export interface Signal {
  id: string;
  graphResourceId: string;
  signalType: 'meeting' | 'email' | 'call';
  tenantId: string;
  userId: string;
  userEmail: string;
  subject: string;
  startTime: string;
  endTime?: string;
  participants: Participant[];
  rawPayload: Record<string, unknown>;
  receivedAt: string;
}

export interface Participant {
  email: string;
  displayName?: string;
  responseStatus?: string;
}

export interface EntityMatch {
  entityType: 'account' | 'contact';
  entityId: string;
  entityName: string;
  matchField: string;
  matchValue: string;
  confidence: number;
}

export interface ConfidenceResult {
  overallConfidence: number;
  accountMatch: EntityMatch | null;
  contactMatches: EntityMatch[];
  requiresReview: boolean;
  reviewReason?: string;
}

export interface UsageCheckResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  licenseTier: 'starter' | 'pro' | 'private';
  reason?: string;
}

export interface ProcessingResult {
  signalId: string;
  graphResourceId: string;
  status: 'processed' | 'queued-for-review' | 'dropped' | 'failed';
  activityId?: string;
  confidence: number;
  message: string;
}

export interface SignalLogEntry {
  signalId: string;
  graphResourceId: string;
  signalType: string;
  status: string;
  confidence: number;
  accountId?: string;
  processingDurationMs: number;
  errorMessage?: string;
  userEmail?: string;
  signalPayload?: string;
  createdAt: string;
}

export interface ReviewQueueItem {
  signalId: string;
  graphResourceId: string;
  signal: Signal;
  entityMatches: ConfidenceResult;
  reviewReason: string;
  status: 'pending' | 'approved' | 'dismissed';
}

// ── Phase 2: Activity Intelligence types ────────────────────────────────────

/** Structured output from AI Summarizer */
export interface MeetingSummary {
  summary: string;
  keyDecisions: string[];
  actionItems: ActionItem[];
  nextSteps: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
  topics: string[];
}

export interface ActionItem {
  description: string;
  assignee?: string;
  dueDate?: string;
}

/** Result from the AI Summarizer service */
export interface SummarizationResult {
  success: boolean;
  meetingSummary?: MeetingSummary;
  tokensUsed: number;
  modelDeployment: string;
  errorMessage?: string;
}

/** An unknown participant detected by Stakeholder Detection */
export interface UnknownStakeholder {
  email: string;
  displayName?: string;
  domain: string;
  suggestedAccountId?: string;
  suggestedAccountName?: string;
  occurrenceCount: number;
}

/** Output from Stakeholder Detection */
export interface StakeholderDetectionResult {
  knownContacts: EntityMatch[];
  unknownStakeholders: UnknownStakeholder[];
  newStakeholderInKnownAccount: boolean;
}

/** Engagement score for an account or opportunity */
export interface EngagementScore {
  entityType: 'account' | 'opportunity';
  entityId: string;
  entityName: string;
  score: number;
  recencyScore: number;
  frequencyScore: number;
  signalCount: number;
  lastSignalDate: string;
  daysSinceLastSignal: number;
  trend: 'increasing' | 'stable' | 'decreasing' | 'inactive';
}

/** Extended processing result for Phase 2 */
export interface ActivityIntelligenceResult extends ProcessingResult {
  summarization?: SummarizationResult;
  stakeholders?: StakeholderDetectionResult;
  engagementScore?: EngagementScore;
}

// ── Phase 3: Opportunity Intelligence types ─────────────────────────────────

/** Default gap thresholds per opportunity stage (days without signal) */
export interface StageGapThreshold {
  stageName: string;
  stageValue: number;
  gapThresholdDays: number;
}

/** An opportunity flagged as at-risk due to activity gap */
export interface ActivityGapAlert {
  opportunityId: string;
  opportunityName: string;
  accountId?: string;
  accountName?: string;
  currentStage: string;
  daysSinceLastSignal: number;
  gapThresholdDays: number;
  engagementScore: number;
  engagementTrend: 'increasing' | 'stable' | 'decreasing' | 'inactive';
  riskReason: string;
}

/** Result of the risk assessment for a single opportunity */
export interface RiskAssessmentResult {
  opportunityId: string;
  isAtRisk: boolean;
  riskFactors: RiskFactor[];
  overallRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  recommendation: string;
}

export interface RiskFactor {
  type: 'activity-gap' | 'engagement-decline' | 'new-stakeholder' | 'sentiment-negative';
  severity: 'low' | 'medium' | 'high';
  description: string;
  data: Record<string, string>;
}

/** Pipeline health metrics for manager dashboard */
export interface PipelineHealthMetrics {
  totalOpportunities: number;
  atRiskCount: number;
  healthyCount: number;
  avgEngagementScore: number;
  avgDaysSinceLastSignal: number;
  trendDistribution: {
    increasing: number;
    stable: number;
    decreasing: number;
    inactive: number;
  };
  riskDistribution: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  generatedAt: string;
}

// ── Phase 4: AI-Assisted Sales Execution types ──────────────────────────────

/** A follow-up email draft generated from meeting context */
export interface EmailDraft {
  subject: string;
  body: string;
  tone: 'formal' | 'professional' | 'casual';
}

/** Result from the follow-up email generator */
export interface FollowUpDraftResult {
  success: boolean;
  draft?: EmailDraft;
  tokensUsed: number;
  errorMessage?: string;
}

/** A persisted AI suggestion linked to an opportunity */
export interface AISuggestion {
  suggestionId: string;
  opportunityId: string;
  suggestionType: string;
  title: string;
  description: string;
  suggestedContent?: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'accepted' | 'dismissed';
  triggerSignal?: string;
  actionData: Record<string, string>;
  createdAt: string;
}

/** Result from task auto-generation */
export interface TaskGenerationResult {
  totalActionItems: number;
  tasksCreated: number;
  tasksSkipped: number;
  tasksFailed: number;
}

// ── Phase 5: AI Agents types ─────────────────────────────────────────────────

/** Request to an AI agent */
export interface AgentRequest {
  tenantId: string;
  userId: string;
}

/** Account Intelligence agent request */
export interface AccountIntelligenceRequest extends AgentRequest {
  accountId: string;
  question: string;
}

/** Opportunity Coach agent request */
export interface OpportunityCoachRequest extends AgentRequest {
  opportunityId: string;
  question: string;
}

/** Sales Execution agent request */
export interface SalesExecutionRequest extends AgentRequest {
  instruction: string;
  context: {
    opportunityId?: string;
    accountId?: string;
    activityId?: string;
  };
}

/** AI Health Dashboard stats for system monitoring */
export interface AIHealthStats {
  signalsProcessed24h: number;
  signalsFailed24h: number;
  signalsInReviewQueue: number;
  avgProcessingTimeMs: number;
  openaiCallsToday: number;
  openaiTokensToday: number;
  usageLimitUtilization: number;
  deadLetterCount: number;
  activeGraphSubscriptions: number;
  lastDeltaPollTime: string;
  errorRate: number;
  topErrors: Array<{ message: string; count: number }>;
}
