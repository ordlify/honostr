// RelayCache.do.ts

import { Bindings, Filters, NostrEvent, RequestMetadata } from "./bindings";
import {
  matchesFilters,
  processEventInBackground,
  getOrCreateRateLimiter,
  fetchEventsFromHelper,
} from "./shared";

interface CacheEntry {
  value: any;
  expires: number;
}

interface SubscriptionData {
  filters: Filters;
  lastAccessed: number;
}

// Update metadata interface
interface SessionMetadata extends RequestMetadata {
  wsId: string;
}

export class RelayCache {
  private state: DurableObjectState;
  private sessions: Map<WebSocket, { metadata: SessionMetadata }>;
  private subscriptionMap: Map<string, Map<string, SubscriptionData>>;
  private wsById: Map<string, WebSocket>;
  public env?: Bindings;

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;

    // Initialize sessions from hibernated WebSockets
    this.sessions = new Map();
    this.subscriptionMap = new Map();
    this.wsById = new Map();

    // Restore sessions from hibernated WebSockets
    this.state.getWebSockets().forEach((ws) => {
      const data = ws.deserializeAttachment();
      if (data) {
        this.sessions.set(ws, data);
        this.wsById.set(data.metadata.wsId, ws);

        if (data.subId && data.filters) {
          let subs = this.subscriptionMap.get(data.wsId);
          if (!subs) {
            subs = new Map();
            this.subscriptionMap.set(data.wsId, subs);
          }
          subs.set(data.subId, {
            filters: data.filters,
            lastAccessed: Date.now(),
          });
        }
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Parse URL parameters for metadata
    const url = new URL(request.url);
    const metadata: SessionMetadata = {
      wsId: crypto.randomUUID(),
      authToken: url.searchParams.get("authToken") || null,
      cached: url.searchParams.get("cached") === "true",
      isAdmin: false,
      captchaToken: null,
    };
    metadata.isAdmin = metadata.authToken === this.env?.AUTH_TOKEN;

    // Accept WebSocket with hibernation support
    this.state.acceptWebSocket(server);
    this.sessions.set(server, { metadata });

    // Serialize initial data
    server.serializeAttachment({ metadata });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async deleteSubscription(
    wsId: string,
    subscriptionId: string
  ): Promise<void> {
    const subs = this.subscriptionMap.get(wsId);
    if (subs) {
      subs.delete(subscriptionId);
      if (subs.size === 0) {
        this.subscriptionMap.delete(wsId);
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      // Handle binary messages
      if (message instanceof ArrayBuffer) {
        ws.send(
          JSON.stringify(["NOTICE", "Binary messages are not supported"])
        );
        return;
      }

      const data = JSON.parse(message);
      if (!Array.isArray(data)) {
        ws.send(JSON.stringify(["NOTICE", "Invalid message format"]));
        return;
      }

      const [type, ...params] = data;
      const session = this.sessions.get(ws);
      if (!session) return;

      switch (type) {
        case "EVENT": {
          const event = params[0];
          await this.handleEvent(ws, event, session.metadata);
          break;
        }
        case "REQ": {
          const [subId, filters] = params;
          await this.handleReq(ws, subId, filters, session.metadata);
          break;
        }
        case "CLOSE": {
          const [subId] = params;
          await this.deleteSubscription(session.metadata.wsId, subId);
          ws.send(
            JSON.stringify(["CLOSED", subId, "subscription closed by client"])
          );
          break;
        }
        default:
          ws.send(JSON.stringify(["NOTICE", `Unknown message type: ${type}`]));
      }
    } catch (error) {
      console.error("Error processing message:", error);
      ws.send(JSON.stringify(["NOTICE", "Error processing message"]));
    }
  }

  async webSocketClose(ws: WebSocket) {
    const session = this.sessions.get(ws);
    if (session) {
      this.wsById.delete(session.metadata.wsId);
      this.subscriptionMap.delete(session.metadata.wsId);
      this.sessions.delete(ws);
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  private async handleEvent(
    ws: WebSocket,
    event: NostrEvent,
    metadata: SessionMetadata
  ) {
    if (!event?.id || !event.pubkey || !event.created_at || !event.sig) {
      ws.send(JSON.stringify(["OK", null, false, "Invalid event format"]));
      return;
    }

    // Send OK immediately
    ws.send(JSON.stringify(["OK", event.id, true, ""]));

    // Process event without awaiting
    processEventInBackground(event, metadata, this.env as Bindings)
      .then((result) => {
        if (!result.success) {
          ws.send(
            JSON.stringify([
              "NOTICE",
              result.error || "Event processing failed",
            ])
          );
          return;
        }

        // Fast subscription matching
        this.broadcastEvent(event);
      })
      .catch((error) => console.error("Event processing error:", error));
  }

  private async handleReq(
    ws: WebSocket,
    subscriptionId: string,
    filters: Filters,
    metadata: SessionMetadata
  ) {
    // Rate limit check
    if (
      !metadata.isAdmin &&
      !getOrCreateRateLimiter(`req:${metadata.wsId}`).removeToken()
    ) {
      ws.send(JSON.stringify(["NOTICE", "Rate limit exceeded"]));
      ws.send(JSON.stringify(["EOSE", subscriptionId]));
      return;
    }

    // Store subscription
    let subs = this.subscriptionMap.get(metadata.wsId);
    if (!subs) {
      subs = new Map();
      this.subscriptionMap.set(metadata.wsId, subs);
    }
    subs.set(subscriptionId, { filters, lastAccessed: Date.now() });

    // Update hibernation data
    ws.serializeAttachment({
      ...ws.deserializeAttachment(),
      wsId: metadata.wsId,
      subId: subscriptionId,
      filters,
    });

    try {
      const events = await fetchEventsFromHelper(
        subscriptionId,
        filters,
        this.env as Bindings
      );

      if (ws.readyState !== WebSocket.OPEN) {
        console.log(`WebSocket closed for subscription ${subscriptionId}`);
        return;
      }

      // Handle limit parameter and send events
      const requestedLimit = filters.limit || 0;
      const limitedEvents =
        requestedLimit > 0 ? events.slice(0, requestedLimit) : events;

      // Send each event individually
      for (const event of limitedEvents) {
        ws.send(JSON.stringify(["EVENT", subscriptionId, event]));
      }

      // Send EOSE after all stored events have been sent
      ws.send(JSON.stringify(["EOSE", subscriptionId]));
    } catch (error) {
      console.error(`REQ error for sub ${subscriptionId}:`, error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(["NOTICE", "Error fetching events"]));
        ws.send(JSON.stringify(["EOSE", subscriptionId])); // Send EOSE even on error
      }
    }
  }

  // Storage methods
  async get(key: string): Promise<NostrEvent | NostrEvent[] | null> {
    const result = await this.state.storage.get<CacheEntry>(key);
    return result && result.expires > Date.now() ? result.value : null;
  }

  async set(
    key: string,
    value: NostrEvent | NostrEvent[],
    ttl: number = 60000
  ): Promise<void> {
    await this.state.storage.put(key, {
      value,
      expires: Date.now() + ttl,
    });
  }

  // Optimized event broadcasting
  private async broadcastEvent(event: NostrEvent) {
    const matchingSubscriptions = new Map<WebSocket, string[]>();

    // Find matching subscriptions
    for (const [wsId, subs] of this.subscriptionMap) {
      const ws = this.wsById.get(wsId);
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;

      const matchingSubIds: string[] = [];
      for (const [subId, subData] of subs) {
        if (matchesFilters(event, subData.filters)) {
          matchingSubIds.push(subId);
        }
      }

      if (matchingSubIds.length > 0) {
        matchingSubscriptions.set(ws, matchingSubIds);
      }
    }

    // Send events individually to each subscription
    for (const [ws, subIds] of matchingSubscriptions) {
      for (const subId of subIds) {
        ws.send(JSON.stringify(["EVENT", subId, event]));
      }
    }
  }
}
