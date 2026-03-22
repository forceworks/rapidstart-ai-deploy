/**
 * DI Container — wires all services for the Signal Processor pipeline.
 * Single initialization, lazy-loaded singletons.
 *
 * Phase 2 additions: AISummarizer, StakeholderDetector, EngagementScorer, UsageGovernance
 * Phase 4 additions: TaskGenerator, NextStepRecommender
 * Phase 5 additions: AI Agents (Account Intelligence, Opportunity Coach, Sales Execution)
 */

import { loadConfig } from '../shared/config.js';
import { createTokenProvider } from '../shared/credentials.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { createDataverseClient, type DataverseClient } from '../shared/dataverse-client.js';
import { createEntityMatcher, type EntityMatcherService } from '../entity-matcher/index.js';
import { createConfidenceScorer, type ConfidenceScorerService } from '../confidence-scorer/index.js';
import { createToolDispatcher, type ToolDispatcherService } from '../tool-dispatcher/index.js';
import { createReviewQueueManager, type ReviewQueueService } from '../review-queue-manager/index.js';
import { createSignalLogService, type SignalLogService } from '../signal-router/signal-log.js';
import { createAISummarizer, type AISummarizerService } from '../ai-summarizer/index.js';
import { createStakeholderDetector, type StakeholderDetectorService } from '../stakeholder-detector/index.js';
import { createEngagementScorer, type EngagementScorerService } from '../engagement-scorer/index.js';
import { createUsageGovernanceService, type UsageGovernanceService } from '../shared/usage-governance.js';
import { createTaskGenerator, type TaskGeneratorService } from '../task-generator/index.js';
import { createNextStepRecommender, type NextStepRecommenderService } from '../nextstep-recommender/index.js';

export interface ServiceContainer {
  logger: Logger;
  dataverseClient: DataverseClient;
  entityMatcher: EntityMatcherService;
  confidenceScorer: ConfidenceScorerService;
  toolDispatcher: ToolDispatcherService;
  reviewQueueManager: ReviewQueueService;
  signalLogService: SignalLogService;
  // Phase 2
  aiSummarizer: AISummarizerService;
  stakeholderDetector: StakeholderDetectorService;
  engagementScorer: EngagementScorerService;
  usageGovernance: UsageGovernanceService;
  // Phase 4
  taskGenerator: TaskGeneratorService;
  nextStepRecommender: NextStepRecommenderService;
}

export function initializeServices(): ServiceContainer {
  const config = loadConfig();
  const tokenProvider = createTokenProvider(config.credentials);
  const logger = createLogger(config.logging.appInsightsConnectionString);

  const dataverseClient = createDataverseClient(
    config.dataverse.toolBaseUrl,
    tokenProvider,
    config.dataverse.url,
    logger
  );

  const entityMatcher = createEntityMatcher(dataverseClient, logger);
  const confidenceScorer = createConfidenceScorer();
  const toolDispatcher = createToolDispatcher(dataverseClient, logger);
  const reviewQueueManager = createReviewQueueManager(dataverseClient, logger);
  const signalLogService = createSignalLogService(dataverseClient, logger);

  // Phase 2 services
  const usageGovernance = createUsageGovernanceService(dataverseClient, config.governance, logger);

  const aiSummarizer = createAISummarizer({
    config: config.openai,
    logger,
    tokenProvider,
    usageGovernance,
  });

  const stakeholderDetector = createStakeholderDetector(dataverseClient, logger);
  const engagementScorer = createEngagementScorer(dataverseClient, logger);

  // Phase 4 services
  const taskGenerator = createTaskGenerator(dataverseClient, logger);
  const nextStepRecommender = createNextStepRecommender(dataverseClient, logger);

  logger.info('Signal processor services initialized (Phase 5)', {
    dataverseUrl: config.dataverse.url,
    licenseTier: config.governance.licenseTier,
    openaiDeployment: config.openai.deployment,
  });

  return {
    logger,
    dataverseClient,
    entityMatcher,
    confidenceScorer,
    toolDispatcher,
    reviewQueueManager,
    signalLogService,
    aiSummarizer,
    stakeholderDetector,
    engagementScorer,
    usageGovernance,
    taskGenerator,
    nextStepRecommender,
  };
}
