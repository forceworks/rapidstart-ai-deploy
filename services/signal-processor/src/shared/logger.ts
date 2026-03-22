/**
 * Structured logging wrapper around Application Insights.
 * Falls back to console logging if App Insights is not configured.
 *
 * Uses dynamic import for applicationinsights to avoid ESM/CJS
 * compatibility issues at module load time in Azure Functions.
 */

export interface Logger {
  info(message: string, properties?: Record<string, string>): void;
  warn(message: string, properties?: Record<string, string>): void;
  error(message: string, properties?: Record<string, string>): void;
  trackSignal(signalId: string, event: string, properties?: Record<string, string>): void;
  trackDependency(name: string, durationMs: number, success: boolean, data?: string): void;
}

// Severity levels matching Application Insights TraceSeverityLevel
const SeverityLevel = {
  Information: 1 as unknown as string,
  Warning: 2 as unknown as string,
  Error: 3 as unknown as string,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let aiClient: any = null;
let aiInitialized = false;

async function ensureAppInsights(connectionString: string): Promise<void> {
  if (aiInitialized) return;
  aiInitialized = true;
  try {
    const mod = await import('applicationinsights');
    const ai = mod.default || mod;
    ai.setup(connectionString)
      .setAutoCollectRequests(true)
      .setAutoCollectExceptions(true)
      .start();
    aiClient = ai.defaultClient;
  } catch (err) {
    console.warn('[LOGGER] Failed to initialize Application Insights:', err);
  }
}

export function createLogger(appInsightsConnectionString?: string): Logger {
  // Kick off async init — telemetry will be available after first await resolves
  if (appInsightsConnectionString) {
    ensureAppInsights(appInsightsConnectionString);
  }

  return {
    info(message: string, properties?: Record<string, string>): void {
      if (aiClient) {
        aiClient.trackTrace({ message, severity: SeverityLevel.Information, properties });
      }
      console.log(`[INFO] ${message}`, properties ? JSON.stringify(properties) : '');
    },

    warn(message: string, properties?: Record<string, string>): void {
      if (aiClient) {
        aiClient.trackTrace({ message, severity: SeverityLevel.Warning, properties });
      }
      console.warn(`[WARN] ${message}`, properties ? JSON.stringify(properties) : '');
    },

    error(message: string, properties?: Record<string, string>): void {
      if (aiClient) {
        aiClient.trackException({
          exception: new Error(message),
          severity: SeverityLevel.Error,
          properties,
        });
      }
      console.error(`[ERROR] ${message}`, properties ? JSON.stringify(properties) : '');
    },

    trackSignal(signalId: string, event: string, properties?: Record<string, string>): void {
      const enriched = { signalId, ...properties };
      if (aiClient) {
        aiClient.trackEvent({ name: `Signal.${event}`, properties: enriched });
      }
      console.log(`[SIGNAL] ${event} signalId=${signalId}`, properties ? JSON.stringify(properties) : '');
    },

    trackDependency(name: string, durationMs: number, success: boolean, data?: string): void {
      if (aiClient) {
        aiClient.trackDependency({
          name,
          duration: durationMs,
          resultCode: success ? 200 : 500,
          success,
          dependencyTypeName: 'HTTP',
          data: data || '',
        });
      }
      console.log(`[DEP] ${name} ${durationMs}ms success=${success}`);
    },
  };
}
