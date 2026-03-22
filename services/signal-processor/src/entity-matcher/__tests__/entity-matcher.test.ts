import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createEntityMatcher,
  extractDomain,
  isFreeEmailDomain,
  normalizeWebsiteDomain,
} from '../index.js';
import { type Signal } from '../../shared/types.js';
import { type DataverseClient } from '../../shared/dataverse-client.js';
import { type Logger } from '../../shared/logger.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trackSignal: vi.fn(),
    trackDependency: vi.fn(),
  };
}

function createMockDataverseClient(overrides?: Partial<DataverseClient>): DataverseClient {
  return {
    get: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue({}),
    executeAction: vi.fn(),
    create: vi.fn().mockResolvedValue('id'),
    update: vi.fn(),
    ...overrides,
  };
}

function createTestSignal(participants: Array<{ email: string }>): Signal {
  return {
    id: 'signal-1',
    graphResourceId: 'graph-1',
    signalType: 'meeting',
    tenantId: 'tenant-1',
    userId: 'user-1',
    userEmail: 'user@test.com',
    subject: 'Test Meeting',
    startTime: '2026-01-01T10:00:00Z',
    participants: participants.map((p) => ({ email: p.email })),
    rawPayload: {},
    receivedAt: '2026-01-01T09:55:00Z',
  };
}

// ─── Pure function tests ────────────────────────────────────────

describe('extractDomain', () => {
  it('extracts domain from valid email', () => {
    expect(extractDomain('user@company.com')).toBe('company.com');
  });

  it('lowercases the domain', () => {
    expect(extractDomain('User@Company.COM')).toBe('company.com');
  });

  it('returns null for invalid email', () => {
    expect(extractDomain('not-an-email')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractDomain('')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(extractDomain('  user@test.com  ')).toBe('test.com');
  });
});

describe('isFreeEmailDomain', () => {
  it('identifies gmail as free', () => {
    expect(isFreeEmailDomain('gmail.com')).toBe(true);
  });

  it('identifies outlook as free', () => {
    expect(isFreeEmailDomain('outlook.com')).toBe(true);
  });

  it('identifies company domain as not free', () => {
    expect(isFreeEmailDomain('company.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isFreeEmailDomain('Gmail.COM')).toBe(true);
  });
});

describe('normalizeWebsiteDomain', () => {
  it('extracts domain from full URL', () => {
    expect(normalizeWebsiteDomain('https://www.company.com/about')).toBe('company.com');
  });

  it('strips www prefix', () => {
    expect(normalizeWebsiteDomain('https://www.example.com')).toBe('example.com');
  });

  it('handles URL without protocol', () => {
    expect(normalizeWebsiteDomain('company.com')).toBe('company.com');
  });

  it('handles http protocol', () => {
    expect(normalizeWebsiteDomain('http://company.com')).toBe('company.com');
  });

  it('returns null for garbage input', () => {
    expect(normalizeWebsiteDomain('')).toBeNull();
  });
});

// ─── Entity Matcher integration tests ───────────────────────────

describe('createEntityMatcher', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it('matches contact by exact email with 0.95 confidence', async () => {
    const mockClient = createMockDataverseClient({
      get: vi.fn().mockImplementation((entitySet: string) => {
        if (entitySet === 'contacts') {
          return Promise.resolve([{
            contactid: 'contact-1',
            fullname: 'Jane Smith',
            emailaddress1: 'jane@partner.com',
          }]);
        }
        return Promise.resolve([]);
      }),
    });

    const matcher = createEntityMatcher(mockClient, mockLogger);
    const signal = createTestSignal([{ email: 'jane@partner.com' }]);
    const matches = await matcher.matchEntities(signal);

    const contactMatch = matches.find((m) => m.entityType === 'contact');
    expect(contactMatch).toBeDefined();
    expect(contactMatch!.confidence).toBe(0.95);
    expect(contactMatch!.entityName).toBe('Jane Smith');
    expect(contactMatch!.matchField).toBe('emailaddress1');
  });

  it('matches account by email domain with 0.70 confidence', async () => {
    const mockClient = createMockDataverseClient({
      get: vi.fn().mockImplementation((entitySet: string, query?: string) => {
        if (entitySet === 'accounts' && query?.includes('emailaddress1')) {
          return Promise.resolve([{
            accountid: 'account-1',
            name: 'Partner Corp',
            emailaddress1: 'info@partner.com',
          }]);
        }
        return Promise.resolve([]);
      }),
    });

    const matcher = createEntityMatcher(mockClient, mockLogger);
    const signal = createTestSignal([{ email: 'jane@partner.com' }]);
    const matches = await matcher.matchEntities(signal);

    const accountMatch = matches.find((m) => m.entityType === 'account' && m.matchField === 'emailaddress1-domain');
    expect(accountMatch).toBeDefined();
    expect(accountMatch!.confidence).toBe(0.70);
    expect(accountMatch!.entityName).toBe('Partner Corp');
  });

  it('matches account by website domain with 0.60 confidence', async () => {
    const mockClient = createMockDataverseClient({
      get: vi.fn().mockImplementation((entitySet: string, query?: string) => {
        if (entitySet === 'accounts' && query?.includes('websiteurl')) {
          return Promise.resolve([{
            accountid: 'account-1',
            name: 'Partner Corp',
            websiteurl: 'https://www.partner.com',
          }]);
        }
        return Promise.resolve([]);
      }),
    });

    const matcher = createEntityMatcher(mockClient, mockLogger);
    const signal = createTestSignal([{ email: 'jane@partner.com' }]);
    const matches = await matcher.matchEntities(signal);

    const websiteMatch = matches.find((m) => m.matchField === 'websiteurl');
    expect(websiteMatch).toBeDefined();
    expect(websiteMatch!.confidence).toBe(0.60);
  });

  it('skips free email domains for account matching', async () => {
    const mockGet = vi.fn().mockResolvedValue([]);
    const mockClient = createMockDataverseClient({ get: mockGet });

    const matcher = createEntityMatcher(mockClient, mockLogger);
    const signal = createTestSignal([{ email: 'jane@gmail.com' }]);
    await matcher.matchEntities(signal);

    // Should only call contacts (1 call), no account domain/website lookups
    const accountCalls = mockGet.mock.calls.filter(
      ([entitySet]: [string]) => entitySet === 'accounts'
    );
    expect(accountCalls).toHaveLength(0);
  });

  it('includes parent account from contact match', async () => {
    const mockClient = createMockDataverseClient({
      get: vi.fn().mockImplementation((entitySet: string) => {
        if (entitySet === 'contacts') {
          return Promise.resolve([{
            contactid: 'contact-1',
            fullname: 'Jane Smith',
            emailaddress1: 'jane@partner.com',
            _parentcustomerid_value: 'account-parent',
          }]);
        }
        return Promise.resolve([]);
      }),
      getById: vi.fn().mockResolvedValue({
        accountid: 'account-parent',
        name: 'Parent Corp',
      }),
    });

    const matcher = createEntityMatcher(mockClient, mockLogger);
    const signal = createTestSignal([{ email: 'jane@partner.com' }]);
    const matches = await matcher.matchEntities(signal);

    const parentMatch = matches.find((m) => m.entityType === 'account' && m.matchField === 'contact-parent');
    expect(parentMatch).toBeDefined();
    expect(parentMatch!.confidence).toBe(0.95);
    expect(parentMatch!.entityName).toBe('Parent Corp');
  });

  it('deduplicates accounts found via multiple paths', async () => {
    const mockClient = createMockDataverseClient({
      get: vi.fn().mockImplementation((entitySet: string, query?: string) => {
        if (entitySet === 'contacts') {
          return Promise.resolve([{
            contactid: 'contact-1',
            fullname: 'Jane Smith',
            emailaddress1: 'jane@partner.com',
            _parentcustomerid_value: 'account-1',
          }]);
        }
        if (entitySet === 'accounts' && query?.includes('emailaddress1')) {
          // Same account found via domain match
          return Promise.resolve([{
            accountid: 'account-1',
            name: 'Partner Corp',
            emailaddress1: 'info@partner.com',
          }]);
        }
        return Promise.resolve([]);
      }),
      getById: vi.fn().mockResolvedValue({
        accountid: 'account-1',
        name: 'Partner Corp',
      }),
    });

    const matcher = createEntityMatcher(mockClient, mockLogger);
    const signal = createTestSignal([{ email: 'jane@partner.com' }]);
    const matches = await matcher.matchEntities(signal);

    // Should have 1 contact + 1 account (not 2 accounts)
    const accountMatches = matches.filter((m) => m.entityType === 'account');
    expect(accountMatches).toHaveLength(1);
    // The first match (from contact parent) should win with higher confidence
    expect(accountMatches[0].confidence).toBe(0.95);
  });

  it('returns empty matches when no participants match', async () => {
    const mockClient = createMockDataverseClient();

    const matcher = createEntityMatcher(mockClient, mockLogger);
    const signal = createTestSignal([{ email: 'unknown@nowhere.com' }]);
    const matches = await matcher.matchEntities(signal);

    expect(matches).toHaveLength(0);
  });

  it('handles multiple participants', async () => {
    const mockClient = createMockDataverseClient({
      get: vi.fn().mockImplementation((entitySet: string, query?: string) => {
        if (entitySet === 'contacts' && query?.includes('jane@partner.com')) {
          return Promise.resolve([{
            contactid: 'contact-1',
            fullname: 'Jane Smith',
            emailaddress1: 'jane@partner.com',
          }]);
        }
        if (entitySet === 'contacts' && query?.includes('bob@other.com')) {
          return Promise.resolve([{
            contactid: 'contact-2',
            fullname: 'Bob Jones',
            emailaddress1: 'bob@other.com',
          }]);
        }
        return Promise.resolve([]);
      }),
    });

    const matcher = createEntityMatcher(mockClient, mockLogger);
    const signal = createTestSignal([
      { email: 'jane@partner.com' },
      { email: 'bob@other.com' },
    ]);
    const matches = await matcher.matchEntities(signal);

    const contactMatches = matches.filter((m) => m.entityType === 'contact');
    expect(contactMatches).toHaveLength(2);
  });

  it('gracefully handles lookup errors without crashing', async () => {
    const mockClient = createMockDataverseClient({
      get: vi.fn().mockRejectedValue(new Error('Dataverse unavailable')),
    });

    const matcher = createEntityMatcher(mockClient, mockLogger);
    const signal = createTestSignal([{ email: 'jane@partner.com' }]);
    const matches = await matcher.matchEntities(signal);

    // Should return empty but not throw
    expect(matches).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
