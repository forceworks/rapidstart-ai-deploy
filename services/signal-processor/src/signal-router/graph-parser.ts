/**
 * Parses Microsoft Graph change notification payloads.
 * Validates schema and filters to actionable change types.
 */

export interface GraphChangeNotification {
  subscriptionId: string;
  changeType: 'created' | 'updated' | 'deleted';
  resource: string;
  resourceData: {
    id: string;
    '@odata.type': string;
  };
  tenantId: string;
  clientState?: string;
}

export interface GraphNotificationPayload {
  value: GraphChangeNotification[];
}

const ACTIONABLE_CHANGE_TYPES = new Set(['created', 'updated']);

/**
 * Parse and validate Graph change notification batch.
 * Filters to only created/updated events (ignores deleted).
 */
export function parseChangeNotifications(body: unknown): GraphChangeNotification[] {
  if (!body || typeof body !== 'object') {
    throw new Error('Invalid notification payload: expected an object');
  }

  const payload = body as Record<string, unknown>;

  if (!Array.isArray(payload.value)) {
    throw new Error('Invalid notification payload: missing "value" array');
  }

  const notifications: GraphChangeNotification[] = [];

  for (const item of payload.value) {
    if (!item || typeof item !== 'object') {
      continue; // skip malformed entries
    }

    const notification = item as Record<string, unknown>;

    // Validate required fields
    if (!notification.resource || typeof notification.resource !== 'string') {
      throw new Error('Invalid notification: missing "resource" field');
    }
    if (!notification.changeType || typeof notification.changeType !== 'string') {
      throw new Error('Invalid notification: missing "changeType" field');
    }
    if (!notification.subscriptionId || typeof notification.subscriptionId !== 'string') {
      throw new Error('Invalid notification: missing "subscriptionId" field');
    }
    if (!notification.tenantId || typeof notification.tenantId !== 'string') {
      throw new Error('Invalid notification: missing "tenantId" field');
    }
    if (!notification.resourceData || typeof notification.resourceData !== 'object') {
      throw new Error('Invalid notification: missing "resourceData" field');
    }

    const resourceData = notification.resourceData as Record<string, unknown>;
    if (!resourceData.id || typeof resourceData.id !== 'string') {
      throw new Error('Invalid notification: missing "resourceData.id" field');
    }

    // Filter to actionable change types
    if (!ACTIONABLE_CHANGE_TYPES.has(notification.changeType as string)) {
      continue;
    }

    notifications.push({
      subscriptionId: notification.subscriptionId as string,
      changeType: notification.changeType as 'created' | 'updated',
      resource: notification.resource as string,
      resourceData: {
        id: resourceData.id as string,
        '@odata.type': (resourceData['@odata.type'] as string) || '',
      },
      tenantId: notification.tenantId as string,
      clientState: notification.clientState as string | undefined,
    });
  }

  return notifications;
}

/**
 * Extract userId and eventId from Graph resource path.
 * Expected format: "users/{userId}/events/{eventId}"
 */
export function extractResourceIds(resource: string): { userId: string; eventId: string } {
  // Match patterns like "users/abc-123/events/def-456"
  // or "Users('abc-123')/Events('def-456')"
  const match = resource.match(/users[\/(']+([^\/\)']+)['\)]*\/events[\/(']+([^\/\)']+)/i);

  if (!match) {
    throw new Error(`Cannot parse resource path: "${resource}". Expected "users/{userId}/events/{eventId}"`);
  }

  return {
    userId: match[1].replace(/['"()]/g, ''),
    eventId: match[2].replace(/['"()]/g, ''),
  };
}
