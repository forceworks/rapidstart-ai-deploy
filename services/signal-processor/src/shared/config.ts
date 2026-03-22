/**
 * Configuration loader — reads and validates all environment variables at startup.
 * Fail fast on missing required values.
 */

export interface AppConfig {
  dataverse: {
    url: string;
    toolBaseUrl: string;
  };
  credentials: {
    source: 'client-credentials' | 'managed-identity';
    tenantId: string;
    clientId?: string;
    clientSecret?: string;
  };
  openai: {
    endpoint: string;
    apiKey?: string;
    deployment: string;
    keySource: 'environment' | 'keyvault';
  };
  serviceBus: {
    connectionString: string;
    signalQueueName: string;
    deadLetterQueueName: string;
  };
  governance: {
    licenseTier: 'starter' | 'pro' | 'private';
    monthlyCapPerUser: number;
  };
  logging: {
    appInsightsConnectionString: string;
    logLevel: string;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string = ''): string {
  return process.env[name] || defaultValue;
}

export function loadConfig(): AppConfig {
  const dataverseUrl = required('DATAVERSE_URL');
  const credentialSource = optional('CREDENTIAL_SOURCE', 'client-credentials');

  if (credentialSource !== 'client-credentials' && credentialSource !== 'managed-identity') {
    throw new Error(`Invalid CREDENTIAL_SOURCE: ${credentialSource}. Must be 'client-credentials' or 'managed-identity'`);
  }

  const licenseTier = optional('LICENSE_TIER', 'pro');
  if (licenseTier !== 'starter' && licenseTier !== 'pro' && licenseTier !== 'private') {
    throw new Error(`Invalid LICENSE_TIER: ${licenseTier}. Must be 'starter', 'pro', or 'private'`);
  }

  return {
    dataverse: {
      url: dataverseUrl,
      toolBaseUrl: optional('RAPIDSSTART_TOOL_BASE_URL', `${dataverseUrl}/api/data/v9.2`),
    },
    credentials: {
      source: credentialSource,
      tenantId: required('TENANT_ID'),
      clientId: credentialSource === 'client-credentials' ? required('CLIENT_ID') : undefined,
      clientSecret: credentialSource === 'client-credentials' ? required('CLIENT_SECRET') : undefined,
    },
    openai: {
      endpoint: required('OPENAI_ENDPOINT'),
      apiKey: optional('OPENAI_API_KEY'),
      deployment: optional('OPENAI_DEPLOYMENT', 'gpt-4o'),
      keySource: (optional('OPENAI_KEY_SOURCE', 'environment') as 'environment' | 'keyvault'),
    },
    serviceBus: {
      connectionString: required('SIGNAL_QUEUE_CONNECTION'),
      signalQueueName: optional('SIGNAL_QUEUE_NAME', 'signals'),
      deadLetterQueueName: optional('DEAD_LETTER_QUEUE_NAME', 'signals-dead-letter'),
    },
    governance: {
      licenseTier,
      monthlyCapPerUser: parseInt(optional('OPENAI_MONTHLY_CAP_PER_USER', '0'), 10),
    },
    logging: {
      appInsightsConnectionString: optional('APPLICATIONINSIGHTS_CONNECTION_STRING'),
      logLevel: optional('LOG_LEVEL', 'info'),
    },
  };
}
