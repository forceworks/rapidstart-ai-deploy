import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDataverseClient } from '../dataverse-client.js';
import { type TokenProvider } from '../credentials.js';
import { type Logger } from '../logger.js';

describe('dataverse-client', () => {
  let mockTokenProvider: TokenProvider;
  let mockLogger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTokenProvider = {
      getToken: vi.fn().mockResolvedValue('mock-token'),
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trackSignal: vi.fn(),
      trackDependency: vi.fn(),
    };
  });

  it('sends GET request with bearer token', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ value: [{ id: '1', name: 'Test' }] }),
      headers: new Headers(),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

    const client = createDataverseClient(
      'https://test.crm.dynamics.com/api/data/v9.2',
      mockTokenProvider,
      'https://test.crm.dynamics.com',
      mockLogger
    );

    const result = await client.get('accounts', "$filter=name eq 'Test'");

    expect(result).toEqual([{ id: '1', name: 'Test' }]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://test.crm.dynamics.com/api/data/v9.2/accounts?$filter=name eq 'Test'",
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer mock-token',
        }),
      })
    );
  });

  it('executes custom API action', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ success: true, activityid: 'act-1' }),
      headers: new Headers(),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

    const client = createDataverseClient(
      'https://test.crm.dynamics.com/api/data/v9.2',
      mockTokenProvider,
      'https://test.crm.dynamics.com',
      mockLogger
    );

    const result = await client.executeAction('fw_LogMeeting', { meetingsubject: 'Test' });

    expect(result).toEqual({ success: true, activityid: 'act-1' });
  });

  it('throws DataverseError on non-retryable failure', async () => {
    const mockResponse = {
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue('Not Found'),
      headers: new Headers(),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

    const client = createDataverseClient(
      'https://test.crm.dynamics.com/api/data/v9.2',
      mockTokenProvider,
      'https://test.crm.dynamics.com',
      mockLogger
    );

    await expect(client.get('accounts')).rejects.toThrow('Dataverse GET');
  });

  it('tracks dependency on every request', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ value: [] }),
      headers: new Headers(),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

    const client = createDataverseClient(
      'https://test.crm.dynamics.com/api/data/v9.2',
      mockTokenProvider,
      'https://test.crm.dynamics.com',
      mockLogger
    );

    await client.get('accounts');

    expect(mockLogger.trackDependency).toHaveBeenCalledWith(
      'Dataverse GET',
      expect.any(Number),
      true,
      expect.stringContaining('accounts')
    );
  });
});
