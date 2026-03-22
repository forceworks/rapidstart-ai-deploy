import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../config.js';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DATAVERSE_URL: 'https://test.crm.dynamics.com',
      TENANT_ID: 'test-tenant-id',
      CREDENTIAL_SOURCE: 'client-credentials',
      CLIENT_ID: 'test-client-id',
      CLIENT_SECRET: 'test-secret',
      OPENAI_ENDPOINT: 'https://test.openai.azure.com',
      OPENAI_API_KEY: 'test-key',
      OPENAI_DEPLOYMENT: 'gpt-4o',
      OPENAI_KEY_SOURCE: 'environment',
      SIGNAL_QUEUE_CONNECTION: 'Endpoint=sb://test.servicebus.windows.net/',
      SIGNAL_QUEUE_NAME: 'signals',
      DEAD_LETTER_QUEUE_NAME: 'signals-dead-letter',
      LICENSE_TIER: 'pro',
      OPENAI_MONTHLY_CAP_PER_USER: '0',
      APPLICATIONINSIGHTS_CONNECTION_STRING: 'InstrumentationKey=test',
      LOG_LEVEL: 'debug',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads all config values correctly', () => {
    const config = loadConfig();

    expect(config.dataverse.url).toBe('https://test.crm.dynamics.com');
    expect(config.credentials.source).toBe('client-credentials');
    expect(config.credentials.tenantId).toBe('test-tenant-id');
    expect(config.credentials.clientId).toBe('test-client-id');
    expect(config.openai.deployment).toBe('gpt-4o');
    expect(config.serviceBus.signalQueueName).toBe('signals');
    expect(config.governance.licenseTier).toBe('pro');
    expect(config.governance.monthlyCapPerUser).toBe(0);
  });

  it('throws on missing required DATAVERSE_URL', () => {
    delete process.env.DATAVERSE_URL;
    expect(() => loadConfig()).toThrow('Missing required environment variable: DATAVERSE_URL');
  });

  it('throws on missing required TENANT_ID', () => {
    delete process.env.TENANT_ID;
    expect(() => loadConfig()).toThrow('Missing required environment variable: TENANT_ID');
  });

  it('throws on invalid CREDENTIAL_SOURCE', () => {
    process.env.CREDENTIAL_SOURCE = 'invalid';
    expect(() => loadConfig()).toThrow("Invalid CREDENTIAL_SOURCE: invalid");
  });

  it('throws on invalid LICENSE_TIER', () => {
    process.env.LICENSE_TIER = 'invalid';
    expect(() => loadConfig()).toThrow("Invalid LICENSE_TIER: invalid");
  });

  it('uses defaults for optional values', () => {
    delete process.env.LOG_LEVEL;
    delete process.env.SIGNAL_QUEUE_NAME;
    const config = loadConfig();
    expect(config.logging.logLevel).toBe('info');
    expect(config.serviceBus.signalQueueName).toBe('signals');
  });
});
