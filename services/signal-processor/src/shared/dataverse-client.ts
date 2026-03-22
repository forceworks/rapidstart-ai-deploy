/**
 * Dataverse Web API HTTP client.
 * Handles token acquisition, retries (429/5xx), and correlation ID headers.
 * All services use this — never raw fetch against Dataverse.
 */

import { type TokenProvider, getDataverseToken } from './credentials.js';
import { type Logger } from './logger.js';
import { DataverseError } from './errors.js';
import { v4 as uuidv4 } from 'uuid';

export interface DataverseClient {
  get<T>(entitySet: string, query?: string): Promise<T[]>;
  getById<T>(entitySet: string, id: string, select?: string[]): Promise<T>;
  executeAction<TRequest, TResponse>(actionName: string, payload: TRequest): Promise<TResponse>;
  create(entitySet: string, data: Record<string, unknown>): Promise<string>;
  update(entitySet: string, id: string, data: Record<string, unknown>): Promise<void>;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDataverseClient(
  baseUrl: string,
  tokenProvider: TokenProvider,
  dataverseUrl: string,
  logger: Logger
): DataverseClient {
  async function makeRequest(
    method: string,
    url: string,
    body?: unknown,
    retryCount = 0
  ): Promise<Response> {
    const correlationId = uuidv4();
    const startTime = Date.now();

    const token = await getDataverseToken(tokenProvider, dataverseUrl);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      'x-ms-correlation-request-id': correlationId,
    };

    if (method === 'POST' || method === 'PATCH') {
      headers['Prefer'] = 'return=representation';
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const durationMs = Date.now() - startTime;
    logger.trackDependency(`Dataverse ${method}`, durationMs, response.ok, url);

    if (response.ok) {
      return response;
    }

    // Retry on 429 (throttled) and 5xx (server error)
    if ((response.status === 429 || response.status >= 500) && retryCount < MAX_RETRIES) {
      const retryAfter = response.headers.get('Retry-After');
      const delayMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : RETRY_DELAY_MS * Math.pow(2, retryCount);

      logger.warn(`Dataverse ${method} ${url} returned ${response.status}, retrying in ${delayMs}ms`, {
        correlationId,
        retryCount: String(retryCount + 1),
      });

      await sleep(delayMs);
      return makeRequest(method, url, body, retryCount + 1);
    }

    const errorBody = await response.text();
    throw new DataverseError(
      `Dataverse ${method} ${url} failed: ${response.status} ${errorBody}`,
      response.status,
      correlationId
    );
  }

  return {
    async get<T>(entitySet: string, query?: string): Promise<T[]> {
      const url = query
        ? `${baseUrl}/${entitySet}?${query}`
        : `${baseUrl}/${entitySet}`;
      const response = await makeRequest('GET', url);
      const data = await response.json() as { value: T[] };
      return data.value;
    },

    async getById<T>(entitySet: string, id: string, select?: string[]): Promise<T> {
      let url = `${baseUrl}/${entitySet}(${id})`;
      if (select?.length) {
        url += `?$select=${select.join(',')}`;
      }
      const response = await makeRequest('GET', url);
      return response.json() as Promise<T>;
    },

    async executeAction<TRequest, TResponse>(actionName: string, payload: TRequest): Promise<TResponse> {
      const url = `${baseUrl}/${actionName}`;
      const response = await makeRequest('POST', url, payload);
      return response.json() as Promise<TResponse>;
    },

    async create(entitySet: string, data: Record<string, unknown>): Promise<string> {
      const url = `${baseUrl}/${entitySet}`;
      const response = await makeRequest('POST', url, data);
      const result = await response.json() as Record<string, unknown>;
      // Dataverse returns the ID in the OData-EntityId header or in the response body
      const entityId = response.headers.get('OData-EntityId');
      if (entityId) {
        const match = entityId.match(/\(([^)]+)\)/);
        return match ? match[1] : String(result[Object.keys(result)[0]]);
      }
      return String(result[Object.keys(result)[0]]);
    },

    async update(entitySet: string, id: string, data: Record<string, unknown>): Promise<void> {
      const url = `${baseUrl}/${entitySet}(${id})`;
      await makeRequest('PATCH', url, data);
    },
  };
}
