import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTokenProvider, getDataverseToken, getGraphToken } from '../credentials.js';
import { type AppConfig } from '../config.js';

// Mock @azure/identity
vi.mock('@azure/identity', () => {
  class MockClientSecretCredential {
    getToken = vi.fn().mockResolvedValue({ token: 'mock-client-secret-token', expiresOnTimestamp: Date.now() + 3600000 });
    constructor(_tenantId: string, _clientId: string, _clientSecret: string) {}
  }
  class MockManagedIdentityCredential {
    getToken = vi.fn().mockResolvedValue({ token: 'mock-managed-identity-token', expiresOnTimestamp: Date.now() + 3600000 });
  }
  return {
    ClientSecretCredential: MockClientSecretCredential,
    ManagedIdentityCredential: MockManagedIdentityCredential,
  };
});

describe('credentials', () => {
  describe('createTokenProvider', () => {
    it('creates client-credentials provider when source is client-credentials', async () => {
      const config: AppConfig['credentials'] = {
        source: 'client-credentials',
        tenantId: 'test-tenant',
        clientId: 'test-client',
        clientSecret: 'test-secret',
      };

      const provider = createTokenProvider(config);
      const token = await provider.getToken(['https://test.crm.dynamics.com/.default']);

      expect(token).toBe('mock-client-secret-token');
    });

    it('creates managed-identity provider when source is managed-identity', async () => {
      const config: AppConfig['credentials'] = {
        source: 'managed-identity',
        tenantId: 'test-tenant',
      };

      const provider = createTokenProvider(config);
      const token = await provider.getToken(['https://test.crm.dynamics.com/.default']);

      expect(token).toBe('mock-managed-identity-token');
    });

    it('throws CredentialError when client-credentials config is incomplete', () => {
      const config: AppConfig['credentials'] = {
        source: 'client-credentials',
        tenantId: 'test-tenant',
        // Missing clientId and clientSecret
      };

      expect(() => createTokenProvider(config)).toThrow('CLIENT_ID and CLIENT_SECRET are required');
    });
  });

  describe('getDataverseToken', () => {
    it('requests token with correct Dataverse scope', async () => {
      const mockProvider = {
        getToken: vi.fn().mockResolvedValue('dataverse-token'),
      };

      const token = await getDataverseToken(mockProvider, 'https://test.crm.dynamics.com');

      expect(mockProvider.getToken).toHaveBeenCalledWith(['https://test.crm.dynamics.com/.default']);
      expect(token).toBe('dataverse-token');
    });
  });

  describe('getGraphToken', () => {
    it('requests token with Graph scope', async () => {
      const mockProvider = {
        getToken: vi.fn().mockResolvedValue('graph-token'),
      };

      const token = await getGraphToken(mockProvider);

      expect(mockProvider.getToken).toHaveBeenCalledWith(['https://graph.microsoft.com/.default']);
      expect(token).toBe('graph-token');
    });
  });
});
