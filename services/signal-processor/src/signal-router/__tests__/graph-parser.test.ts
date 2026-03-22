import { describe, it, expect } from 'vitest';
import { parseChangeNotifications, extractResourceIds } from '../graph-parser.js';

describe('graph-parser', () => {
  describe('parseChangeNotifications', () => {
    const validNotification = {
      subscriptionId: 'sub-1',
      changeType: 'created',
      resource: 'users/user-1/events/event-1',
      resourceData: { id: 'event-1', '@odata.type': '#Microsoft.Graph.Event' },
      tenantId: 'tenant-1',
      clientState: 'secret',
    };

    it('parses valid notification batch', () => {
      const result = parseChangeNotifications({ value: [validNotification] });

      expect(result).toHaveLength(1);
      expect(result[0].subscriptionId).toBe('sub-1');
      expect(result[0].changeType).toBe('created');
      expect(result[0].resourceData.id).toBe('event-1');
      expect(result[0].tenantId).toBe('tenant-1');
    });

    it('filters out deleted change types', () => {
      const deleted = { ...validNotification, changeType: 'deleted' };
      const result = parseChangeNotifications({ value: [validNotification, deleted] });

      expect(result).toHaveLength(1);
      expect(result[0].changeType).toBe('created');
    });

    it('includes updated change types', () => {
      const updated = { ...validNotification, changeType: 'updated' };
      const result = parseChangeNotifications({ value: [updated] });

      expect(result).toHaveLength(1);
      expect(result[0].changeType).toBe('updated');
    });

    it('throws on null body', () => {
      expect(() => parseChangeNotifications(null)).toThrow('expected an object');
    });

    it('throws on missing value array', () => {
      expect(() => parseChangeNotifications({})).toThrow('missing "value" array');
    });

    it('throws on missing resource field', () => {
      const bad = { ...validNotification, resource: undefined };
      expect(() => parseChangeNotifications({ value: [bad] })).toThrow('missing "resource"');
    });

    it('throws on missing changeType field', () => {
      const bad = { ...validNotification, changeType: undefined };
      expect(() => parseChangeNotifications({ value: [bad] })).toThrow('missing "changeType"');
    });

    it('throws on missing tenantId field', () => {
      const bad = { ...validNotification, tenantId: undefined };
      expect(() => parseChangeNotifications({ value: [bad] })).toThrow('missing "tenantId"');
    });

    it('throws on missing resourceData.id', () => {
      const bad = { ...validNotification, resourceData: { '@odata.type': 'test' } };
      expect(() => parseChangeNotifications({ value: [bad] })).toThrow('missing "resourceData.id"');
    });

    it('handles multiple notifications', () => {
      const second = { ...validNotification, resourceData: { id: 'event-2', '@odata.type': '' } };
      const result = parseChangeNotifications({ value: [validNotification, second] });

      expect(result).toHaveLength(2);
    });

    it('skips malformed entries in batch', () => {
      const result = parseChangeNotifications({ value: [null, validNotification] });
      expect(result).toHaveLength(1);
    });
  });

  describe('extractResourceIds', () => {
    it('extracts userId and eventId from standard path', () => {
      const result = extractResourceIds('users/abc-123/events/def-456');

      expect(result.userId).toBe('abc-123');
      expect(result.eventId).toBe('def-456');
    });

    it('handles paths with extra segments before', () => {
      const result = extractResourceIds('Users/abc/Events/def');
      expect(result.userId).toBe('abc');
      expect(result.eventId).toBe('def');
    });

    it('strips quotes and parens from OData-style paths', () => {
      const result = extractResourceIds("Users('abc')/Events('def')");
      expect(result.userId).toBe('abc');
      expect(result.eventId).toBe('def');
    });

    it('throws on invalid resource path', () => {
      expect(() => extractResourceIds('invalid/path')).toThrow('Cannot parse resource path');
    });

    it('throws on empty string', () => {
      expect(() => extractResourceIds('')).toThrow('Cannot parse resource path');
    });
  });
});
