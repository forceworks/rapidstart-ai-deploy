/**
 * Function registrations entry point.
 * Imports all function modules so their app.http / app.serviceBusQueue / app.timer
 * registrations are executed at startup.
 */

// Signal Router — HTTP trigger for Graph webhook notifications
import '../signal-router/index.js';

// Signal Processor — Service Bus trigger for processing signals
import '../signal-processor/index.js';

// Dead-Letter Handler — Service Bus trigger for DLQ
import '../dead-letter-handler/index.js';

// Graph Webhooks — Timer triggers for subscription renewal and delta polling
import '../graph-webhooks/renewal-timer.js';
import '../graph-webhooks/delta-poll-timer.js';

// Activity Gap Detector — Daily timer for opportunity risk scanning (Phase 3)
import '../activity-gap-detector/gap-scan-timer.js';

// Engagement Trend Analyzer — Periodic engagement score refresh (Phase 3)
import '../engagement-trend-analyzer/trend-refresh-timer.js';

// Stakeholder Alert Scanner — Daily scan for new stakeholder patterns (Phase 3)
import '../stakeholder-alert/alert-scan-timer.js';

// AI Agent HTTP endpoints (Phase 5)
import '../agents/agent-api.js';
