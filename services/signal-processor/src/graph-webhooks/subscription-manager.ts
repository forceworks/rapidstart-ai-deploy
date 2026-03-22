/**
 * Graph Subscription Manager — creates, renews, and deletes
 * Microsoft Graph webhook subscriptions for calendar event changes.
 *
 * Subscriptions expire after max 3 days (4230 minutes) for calendar events.
 * We renew every 12 hours to stay well within the window.
 */

import { type TokenProvider, getGraphToken } from '../shared/credentials.js';
import { type Logger } from '../shared/logger.js';
import { type DataverseClient } from '../shared/dataverse-client.js';

export interface GraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState?: string;
}

interface SubscriptionRecord {
  fw_graphsubscriptionid: string;
  fw_subscriptionid: string;
  fw_resource: string;
  fw_notificationurl: string;
  fw_expiration: string;
  fw_userid: string;
}

export interface SubscriptionManager {
  /** Create a new subscription for a user's calendar events */
  createSubscription(userId: string, notificationUrl: string): Promise<GraphSubscription>;
  /** Renew an existing subscription */
  renewSubscription(subscriptionId: string): Promise<GraphSubscription>;
  /** Delete a subscription */
  deleteSubscription(subscriptionId: string): Promise<void>;
  /** List all active subscriptions from Dataverse tracking table */
  listActiveSubscriptions(): Promise<SubscriptionRecord[]>;
}

const SUBSCRIPTION_EXPIRY_HOURS = 48; // Max is ~70h for calendar events; we use 48h
const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

export function createSubscriptionManager(
  tokenProvider: TokenProvider,
  dataverseClient: DataverseClient,
  logger: Logger
): SubscriptionManager {
  async function graphFetch(method: string, url: string, body?: unknown): Promise<Response> {
    const token = await getGraphToken(tokenProvider);
    const startTime = Date.now();

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const durationMs = Date.now() - startTime;
    logger.trackDependency(`Graph.${method}`, durationMs, response.ok, url);

    return response;
  }

  function getExpirationDate(): string {
    const expiry = new Date();
    expiry.setHours(expiry.getHours() + SUBSCRIPTION_EXPIRY_HOURS);
    return expiry.toISOString();
  }

  return {
    async createSubscription(userId: string, notificationUrl: string): Promise<GraphSubscription> {
      const payload = {
        changeType: 'created,updated,deleted',
        notificationUrl,
        resource: `users/${userId}/events`,
        expirationDateTime: getExpirationDate(),
        clientState: 'rapidstart-ai',
      };

      const response = await graphFetch('POST', `${GRAPH_API_BASE}/subscriptions`, payload);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create subscription: ${response.status} ${errorText}`);
      }

      const subscription = (await response.json()) as GraphSubscription;

      // Track in Dataverse
      await dataverseClient.create('fw_graphsubscriptions', {
        fw_subscriptionid: subscription.id,
        fw_resource: `users/${userId}/events`,
        fw_notificationurl: notificationUrl,
        fw_expiration: subscription.expirationDateTime,
        fw_userid: userId,
      });

      logger.info('Graph subscription created', {
        subscriptionId: subscription.id,
        userId,
        expiration: subscription.expirationDateTime,
      });

      return subscription;
    },

    async renewSubscription(subscriptionId: string): Promise<GraphSubscription> {
      const payload = {
        expirationDateTime: getExpirationDate(),
      };

      const response = await graphFetch(
        'PATCH',
        `${GRAPH_API_BASE}/subscriptions/${subscriptionId}`,
        payload
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to renew subscription ${subscriptionId}: ${response.status} ${errorText}`);
      }

      const subscription = (await response.json()) as GraphSubscription;

      // Update expiration in Dataverse tracking
      const records = await dataverseClient.get<SubscriptionRecord>(
        'fw_graphsubscriptions',
        `$filter=fw_subscriptionid eq '${subscriptionId}'&$top=1&$select=fw_graphsubscriptionid`
      );

      if (records.length > 0) {
        await dataverseClient.update('fw_graphsubscriptions', records[0].fw_graphsubscriptionid, {
          fw_expiration: subscription.expirationDateTime,
        });
      }

      logger.info('Graph subscription renewed', {
        subscriptionId,
        newExpiration: subscription.expirationDateTime,
      });

      return subscription;
    },

    async deleteSubscription(subscriptionId: string): Promise<void> {
      const response = await graphFetch(
        'DELETE',
        `${GRAPH_API_BASE}/subscriptions/${subscriptionId}`
      );

      if (!response.ok && response.status !== 404) {
        const errorText = await response.text();
        throw new Error(`Failed to delete subscription ${subscriptionId}: ${response.status} ${errorText}`);
      }

      // Remove from Dataverse tracking
      const records = await dataverseClient.get<SubscriptionRecord>(
        'fw_graphsubscriptions',
        `$filter=fw_subscriptionid eq '${subscriptionId}'&$top=1&$select=fw_graphsubscriptionid`
      );

      // For now just log deletion. In production, we'd soft-delete or remove.
      logger.info('Graph subscription deleted', { subscriptionId });
    },

    async listActiveSubscriptions(): Promise<SubscriptionRecord[]> {
      const now = new Date().toISOString();
      return dataverseClient.get<SubscriptionRecord>(
        'fw_graphsubscriptions',
        `$filter=fw_expiration gt ${now}&$select=fw_graphsubscriptionid,fw_subscriptionid,fw_resource,fw_notificationurl,fw_expiration,fw_userid`
      );
    },
  };
}
