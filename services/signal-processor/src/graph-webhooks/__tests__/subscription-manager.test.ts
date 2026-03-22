import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSubscriptionManager } from '../subscription-manager.js';
import { type DataverseClient } from '../../shared/dataverse-client.js';
import { type Logger } from '../../shared/logger.js';
import { type TokenProvider } from '../../shared/credentials.js';

// Mock getGraphToken
vi.mock('../../shared/credentials.js', () => ({
  getGraphToken: vi.fn().mockResolvedValue('mock-graph-token'),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trackSignal: vi.fn(),
    trackDependency: vi.fn(),
  };
}

function createMockDataverseClient(): DataverseClient {
  return {
    get: vi.fn().mockResolvedValue([]),
    getById: vi.fn(),
    executeAction: vi.fn(),
    create: vi.fn().mockResolvedValue('record-id'),
    update: vi.fn(),
  };
}

const mockTokenProvider: TokenProvider = {
  getToken: vi.fn().mockResolvedValue({ token: 'token', expiresOnTimestamp: Date.now() + 3600000 }),
};

describe('subscriptionManager', () => {
  let mockLogger: Logger;
  let mockClient: DataverseClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    mockClient = createMockDataverseClient();
  });

  it('creates a subscription via Graph API and tracks in Dataverse', async () => {
    const subscriptionResponse = {
      id: 'sub-123',
      resource: 'users/user-1/events',
      changeType: 'created,updated,deleted',
      notificationUrl: 'https://func.azurewebsites.net/api/signal-router',
      expirationDateTime: '2026-01-03T10:00:00Z',
      clientState: 'rapidstart-ai',
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(subscriptionResponse),
    });

    const manager = createSubscriptionManager(mockTokenProvider, mockClient, mockLogger);
    const result = await manager.createSubscription('user-1', 'https://func.azurewebsites.net/api/signal-router');

    expect(result.id).toBe('sub-123');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/subscriptions',
      expect.objectContaining({ method: 'POST' })
    );
    expect(mockClient.create).toHaveBeenCalledWith(
      'fw_graphsubscriptions',
      expect.objectContaining({
        fw_subscriptionid: 'sub-123',
        fw_userid: 'user-1',
      })
    );
  });

  it('renews a subscription and updates Dataverse', async () => {
    const renewedSubscription = {
      id: 'sub-123',
      expirationDateTime: '2026-01-05T10:00:00Z',
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(renewedSubscription),
    });

    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { fw_graphsubscriptionid: 'dv-record-1', fw_subscriptionid: 'sub-123' },
    ]);

    const manager = createSubscriptionManager(mockTokenProvider, mockClient, mockLogger);
    const result = await manager.renewSubscription('sub-123');

    expect(result.expirationDateTime).toBe('2026-01-05T10:00:00Z');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/subscriptions/sub-123',
      expect.objectContaining({ method: 'PATCH' })
    );
    expect(mockClient.update).toHaveBeenCalledWith(
      'fw_graphsubscriptions',
      'dv-record-1',
      expect.objectContaining({ fw_expiration: '2026-01-05T10:00:00Z' })
    );
  });

  it('throws on Graph API error during creation', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    });

    const manager = createSubscriptionManager(mockTokenProvider, mockClient, mockLogger);

    await expect(
      manager.createSubscription('user-1', 'https://func.azurewebsites.net/api/signal-router')
    ).rejects.toThrow('Failed to create subscription: 403');
  });

  it('deletes a subscription from Graph API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
    });

    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const manager = createSubscriptionManager(mockTokenProvider, mockClient, mockLogger);
    await manager.deleteSubscription('sub-123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/subscriptions/sub-123',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('lists active subscriptions from Dataverse', async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { fw_graphsubscriptionid: 'dv-1', fw_subscriptionid: 'sub-1', fw_userid: 'user-1' },
      { fw_graphsubscriptionid: 'dv-2', fw_subscriptionid: 'sub-2', fw_userid: 'user-2' },
    ]);

    const manager = createSubscriptionManager(mockTokenProvider, mockClient, mockLogger);
    const subs = await manager.listActiveSubscriptions();

    expect(subs).toHaveLength(2);
    expect(mockClient.get).toHaveBeenCalledWith(
      'fw_graphsubscriptions',
      expect.stringContaining('fw_expiration gt')
    );
  });
});
