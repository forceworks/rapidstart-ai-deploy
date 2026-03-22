/**
 * Credential abstraction — switches between client-credentials and managed-identity
 * based on CREDENTIAL_SOURCE env var. All services use this interface, never inline creds.
 */

import { ClientSecretCredential, ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import { type AppConfig } from './config.js';
import { CredentialError } from './errors.js';

export interface TokenProvider {
  getToken(scopes: string[]): Promise<string>;
}

export function createTokenProvider(config: AppConfig['credentials']): TokenProvider {
  let credential: TokenCredential;

  if (config.source === 'client-credentials') {
    if (!config.clientId || !config.clientSecret) {
      throw new CredentialError(
        'CLIENT_ID and CLIENT_SECRET are required for client-credentials source',
        'client-credentials'
      );
    }
    credential = new ClientSecretCredential(
      config.tenantId,
      config.clientId,
      config.clientSecret
    );
  } else {
    credential = new ManagedIdentityCredential();
  }

  return {
    async getToken(scopes: string[]): Promise<string> {
      try {
        const result = await credential.getToken(scopes);
        if (!result) {
          throw new CredentialError('Token acquisition returned null', config.source);
        }
        return result.token;
      } catch (error) {
        if (error instanceof CredentialError) throw error;
        throw new CredentialError(
          `Failed to acquire token: ${(error as Error).message}`,
          config.source
        );
      }
    },
  };
}

/** Convenience wrapper matching the setup guide's getDataverseToken() naming */
export async function getDataverseToken(
  tokenProvider: TokenProvider,
  dataverseUrl: string
): Promise<string> {
  return tokenProvider.getToken([`${dataverseUrl}/.default`]);
}

/** Get a Graph API token */
export async function getGraphToken(tokenProvider: TokenProvider): Promise<string> {
  return tokenProvider.getToken(['https://graph.microsoft.com/.default']);
}
