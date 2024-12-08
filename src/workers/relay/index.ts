// workers/relay/index.ts
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import { Context } from "hono";
import { MessageEvent, CloseEvent, Event } from "@cloudflare/workers-types";
import { WSContext } from "hono/ws";
import { schnorr } from "@noble/curves/secp256k1";
import { Bindings, NostrEvent, Filters } from "./bindings";
import {
  relayInfo,
  relayIcon,
  nip05Users,
  eventHelpers,
  reqHelpers,
  blockedPubkeys,
  allowedPubkeys,
  blockedEventKinds,
  allowedEventKinds,
  blockedContent,
  blockedNip05Domains,
  allowedNip05Domains,
  blockedTags,
  allowedTags,
} from "./config";

const app = new Hono<{ Bindings: Bindings }>();

function isPubkeyAllowed(pubkey: string): boolean {
  if (allowedPubkeys.size > 0 && !allowedPubkeys.has(pubkey)) {
    return false;
  }
  return !blockedPubkeys.has(pubkey);
}

function isEventKindAllowed(kind: number): boolean {
  if (allowedEventKinds.size > 0 && !allowedEventKinds.has(kind)) {
    return false;
  }
  return !blockedEventKinds.has(kind);
}

function containsBlockedContent(event: NostrEvent): boolean {
  const lowercaseContent = (event.content || "").toLowerCase();
  const lowercaseTags = event.tags.map((tag) => tag.join("").toLowerCase());

  for (const blocked of blockedContent) {
    const blockedLower = blocked.toLowerCase();
    if (
      lowercaseContent.includes(blockedLower) ||
      lowercaseTags.some((tag) => tag.includes(blockedLower))
    ) {
      return true;
    }
  }
  return false;
}

function isTagAllowed(tag: string): boolean {
  if (allowedTags.size > 0 && !allowedTags.has(tag)) {
    return false;
  }
  return !blockedTags.has(tag);
}

// In-memory cache and subscriptions
const relayCache = {
  _cache: new Map<string, any>(),
  _subscriptions: new Map<string, Map<string, Filters>>(),

  get(key: string) {
    const item = this._cache.get(key);
    if (item && item.expires > Date.now()) {
      return item.value;
    }
    return null;
  },
  set(key: string, value: any, ttl = 60000) {
    this._cache.set(key, {
      value,
      expires: Date.now() + ttl,
    });
  },
  delete(key: string) {
    this._cache.delete(key);
  },
  addSubscription(wsId: string, subscriptionId: string, filters: Filters) {
    if (!this._subscriptions.has(wsId)) {
      this._subscriptions.set(wsId, new Map());
    }
    this._subscriptions.get(wsId)!.set(subscriptionId, filters);
  },
  getSubscription(wsId: string, subscriptionId: string) {
    return this._subscriptions.get(wsId)?.get(subscriptionId) || null;
  },
  deleteSubscription(wsId: string, subscriptionId: string) {
    this._subscriptions.get(wsId)?.delete(subscriptionId);
  },
  clearSubscriptions(wsId: string) {
    this._subscriptions.delete(wsId);
  },
};

// Rate limiters
class RateLimiter {
  tokens: number;
  lastRefillTime: number;
  capacity: number;
  fillRate: number;

  constructor(rate: number, capacity: number) {
    this.tokens = capacity;
    this.lastRefillTime = Date.now();
    this.capacity = capacity;
    this.fillRate = rate; // tokens per millisecond
  }

  removeToken() {
    this.refill();
    if (this.tokens < 1) {
      return false; // no tokens available, rate limit exceeded
    }
    this.tokens -= 1;
    return true;
  }

  refill() {
    const now = Date.now();
    const elapsedTime = now - this.lastRefillTime;
    const tokensToAdd = Math.floor(elapsedTime * this.fillRate);
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }
}

const pubkeyRateLimiter = new RateLimiter(10 / 60000, 10); // 10 EVENT messages per min
const reqRateLimiter = new RateLimiter(10 / 60000, 10); // 10 REQ messages per min
const excludedRateLimitKinds: number[] = []; // kinds to exclude from EVENT rate limiting Ex: 1, 2, 3

// Controls concurrent connections
const MAX_CONCURRENT_CONNECTIONS = 6;
let activeConnections = 0;

// Controls number of active connections
async function withConnectionLimit<T>(
  promiseFunction: () => Promise<T>
): Promise<T> {
  // Wait if too many connections are active
  while (activeConnections >= MAX_CONCURRENT_CONNECTIONS) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  activeConnections += 1;
  try {
    return await promiseFunction();
  } finally {
    activeConnections -= 1;
  }
}

const subscriptions = new Map<
  string,
  {
    ws: WSContext<WebSocket>;
    filters: Map<string, Filters>;
  }
>();

// Hono route handlers

// WebSocket Route
app.get("/", upgradeWebSocket(handleWebSocket));

// HTTP Route
app.get("/", async (c) => {
  const acceptHeader = c.req.header("Accept");

  if (acceptHeader && acceptHeader.includes("application/nostr+json")) {
    return handleRelayInfoRequest(c);
  } else {
    return c.text("Connect using a Nostr client");
  }
});

// Route for '/.well-known/nostr.json'
app.get("/.well-known/nostr.json", async (c) => {
  return handleNIP05Request(c);
});

// Route for '/favicon.ico'
app.get("/favicon.ico", async (c) => {
  return serveFavicon(c);
});

export default app;

// Function to handle Relay Info Request
async function handleRelayInfoRequest(c: Context) {
  const headers = {
    "Content-Type": "application/nostr+json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Allow-Methods": "GET",
  };
  return c.json(relayInfo, 200, headers);
}

// Function to serve Favicon
async function serveFavicon(c: Context) {
  const response = await fetch(relayIcon);
  if (response.ok) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "max-age=3600");
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }
  return c.text("Not found", 404);
}

// Function to handle NIP05 Requests
async function handleNIP05Request(c: Context) {
  const url = new URL(c.req.url);
  const name = url.searchParams.get("name");
  if (!name) {
    return c.json({ error: "Missing 'name' parameter" }, 400);
  }
  const pubkey = nip05Users[name.toLowerCase()];
  if (!pubkey) {
    return c.json({ error: "User not found" }, 404);
  }
  const response = {
    names: {
      [name]: pubkey,
    },
    relays: {
      [pubkey]: [
        // ... add relays for NIP-05 users
      ],
    },
  };
  return c.json(response, 200, {
    "Access-Control-Allow-Origin": "*",
  });
}

// Function to handle WebSocket connections
function handleWebSocket(c: Context<{ Bindings: Bindings }>) {
  const env = c.env;
  const wsId = crypto.randomUUID();
  let initialized = false;

  console.log(`[WS] Generated new wsId: ${wsId}`);

  return {
    onOpen(ws: WSContext<WebSocket>) {
      try {
        // Store the connection
        subscriptions.set(wsId, {
          ws,
          filters: new Map(),
        });
        initialized = true;

        console.log(`[WS] Connection opened for wsId: ${wsId}`);
        console.log(`[WS] Active connections: ${subscriptions.size}`);

        // Send a welcome message to verify connection
        ws.send(JSON.stringify(["NOTICE", "Welcome to Nostr relay"]));
      } catch (error) {
        console.error(`[WS] Error in onOpen for wsId ${wsId}:`, error);
      }
    },
    onMessage(evt: MessageEvent, ws: WSContext<WebSocket>): void {
      (async () => {
        try {
          // If connection hasn't been initialized yet, do it now
          if (!initialized) {
            subscriptions.set(wsId, {
              ws,
              filters: new Map(),
            });
            initialized = true;
            console.log(`[WS] Late initialization for wsId: ${wsId}`);
          }

          let messageData: any;
          if (evt.data instanceof ArrayBuffer) {
            const textDecoder = new TextDecoder("utf-8");
            const decodedText = textDecoder.decode(evt.data);
            messageData = JSON.parse(decodedText);
          } else {
            messageData = JSON.parse(evt.data);
          }

          const messageType = messageData[0];
          console.log(`[WS] Received ${messageType} message for wsId: ${wsId}`);

          switch (messageType) {
            case "EVENT":
              await processEvent(messageData[1], wsId, env);
              break;
            case "REQ":
              await processReq(messageData, wsId, env);
              break;
            case "CLOSE":
              await closeSubscription(messageData[1], wsId);
              break;
          }
        } catch (e) {
          console.error(`[WS] Error processing message for wsId ${wsId}:`, e);
          sendError(wsId, "Failed to process the message");
        }
      })();
    },
    onClose(evt: CloseEvent, ws: WSContext<WebSocket>) {
      console.log(`[WS] Closing connection for wsId: ${wsId}`);
      subscriptions.delete(wsId);
      console.log(`[WS] Remaining connections: ${subscriptions.size}`);
    },
    onError(evt: Event, ws: WSContext<WebSocket>) {
      console.error(`[WS] Error for wsId ${wsId}:`, evt);
      subscriptions.delete(wsId);
    },
  };
}

// Process EVENT messages
async function processEvent(event: NostrEvent, wsId: string, env: Bindings) {
  try {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      console.error(
        `[Event] Invalid JSON format for event: ${JSON.stringify(
          event
        )}. Expected a JSON object.`
      );
      sendOK(wsId, null, false, "Invalid JSON format. Expected a JSON object.");
      return;
    }

    // Log event processing start
    console.log(`[Event] Processing event ${event.id}`);

    // Check cache for duplicate event ID
    const cacheKey = `event:${event.id}`;
    const cachedEvent = relayCache.get(cacheKey);
    if (cachedEvent) {
      console.log(
        `[Event] Duplicate event detected: ${event.id}. Dropping event.`
      );
      sendOK(wsId, event.id, false, "Duplicate. Event dropped.");
      return;
    }

    // Verify event signature
    const isValidSignature = await verifyEventSignature(event);
    if (!isValidSignature) {
      console.error(
        `[Event] Signature verification failed for event ${event.id}`
      );
      sendOK(wsId, event.id, false, "Invalid: signature verification failed.");
      return;
    } else {
      console.log(
        `[Event] Signature verification passed for event ${event.id}`
      );
    }

    // Add event to cache with a TTL of 60 seconds
    relayCache.set(cacheKey, event, 60000);
    console.log(`[Event] Event ${event.id} cached with a TTL of 60 seconds`);

    // Acknowledge the event to the client
    sendOK(wsId, event.id, true, "Event received successfully for processing.");
    console.log(`[Event] Event ${event.id} acknowledged to the client`);

    // Process the event asynchronously
    processEventInBackground(event, wsId, env);
  } catch (error) {
    console.error(`[Event] Error in processing event ${event.id}:`, error);
    sendOK(
      wsId,
      event.id,
      false,
      `Error: EVENT processing failed - ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// Process the event asynchronously in the background
async function processEventInBackground(
  event: NostrEvent,
  wsId: string,
  env: Bindings
) {
  const connection = subscriptions.get(wsId);
  if (!connection) {
    console.error(`[Event] WebSocket not found for wsId: ${wsId}`);
    return;
  }
  try {
    // Log event processing start
    console.log(`[Event] Processing event ${event.id} in the background`);

    // Check if the pubkey is allowed
    if (!isPubkeyAllowed(event.pubkey)) {
      console.error(
        `[Event] Event denied. Pubkey ${event.pubkey} is not allowed.`
      );
      return {
        success: false,
        error: `Pubkey ${event.pubkey} is not allowed.`,
      };
    }

    // Check if the event kind is allowed
    if (!isEventKindAllowed(event.kind)) {
      console.error(
        `[Event] Event denied. Event kind ${event.kind} is not allowed.`
      );
      return {
        success: false,
        error: `Event kind ${event.kind} is not allowed.`,
      };
    }

    // Check for blocked content
    if (containsBlockedContent(event)) {
      console.error(`[Event] Event denied. Content contains blocked phrases.`);
      return { success: false, error: "Event contains blocked content." };
    }

    // Check if the tags are allowed or blocked
    for (const tag of event.tags) {
      const tagKey = tag[0];

      // If the tag is not allowed, reject the event
      if (!isTagAllowed(tagKey)) {
        console.error(`[Event] Event denied. Tag '${tagKey}' is not allowed.`);
        return { success: false, error: `Tag '${tagKey}' is not allowed.` };
      }

      // If the tag is blocked, reject the event
      if (blockedTags.has(tagKey)) {
        console.error(`[Event] Event denied. Tag '${tagKey}' is blocked.`);
        return { success: false, error: `Tag '${tagKey}' is blocked.` };
      }
    }

    // NIP-05 validation
    if (event.kind !== 0) {
      const isValidNIP05 = await validateNIP05FromKind0(event.pubkey, env);
      if (!isValidNIP05) {
        console.error(
          `[Event] Event denied. NIP-05 validation failed for pubkey ${event.pubkey}.`
        );
        return {
          success: false,
          error: `NIP-05 validation failed for pubkey ${event.pubkey}.`,
        };
      }
    }

    // Rate limit all event kinds except excluded kinds
    if (!excludedRateLimitKinds.includes(event.kind)) {
      if (!pubkeyRateLimiter.removeToken()) {
        console.error(
          `[Event] Event denied. Rate limit exceeded for pubkey ${event.pubkey}.`
        );
        return {
          success: false,
          error: "Rate limit exceeded. Please try again later.",
        };
      }
    }

    // Send event to matching subscriptions
    const subscriptions = relayCache._subscriptions.get(wsId);

    if (subscriptions) {
      let matched = false;
      for (const [subscriptionId, filters] of subscriptions.entries()) {
        if (matchesFilters(event, filters)) {
          matched = true;
          console.log(
            `[Event] Event ${event.id} matched subscription ${subscriptionId}`
          );
          connection.ws.send(JSON.stringify(["EVENT", subscriptionId, event]));
        }
      }
      if (!matched) {
        console.log(
          `[Event] Event ${event.id} did not match any subscriptions for wsId: ${wsId}`
        );
      }
    }

    // Update the cache for matching subscriptions in memory
    for (const [wsId, wsSubscriptions] of relayCache._subscriptions.entries()) {
      for (const [subscriptionId, filters] of wsSubscriptions.entries()) {
        if (matchesFilters(event, filters)) {
          const cacheKey = `req:${JSON.stringify(filters)}`;
          const cachedEvents = relayCache.get(cacheKey) || [];
          cachedEvents.push(event);

          // Log cache update
          console.log(
            `[Event] Event ${event.id} added to cache for subscription ${subscriptionId}`
          );
          relayCache.set(cacheKey, cachedEvents, 60000); // Cache for 60 seconds
        }
      }
    }

    // Forward the event to helper workers
    console.log(`[Event] Forwarding event ${event.id} to helper workers`);
    await sendEventToHelper(event, env);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error("[Event] Error in background event processing:", error);
      return { success: false, error: `Error: ${error.message}` };
    } else {
      console.error("[Event] Error in background event processing:", error);
      return { success: false, error: "An unknown error occurred" };
    }
  }
}

// Process REQ messages
async function processReq(message: any, wsId: string, env: Bindings) {
  const subscriptionId = message[1];
  const filters: Filters = message[2] || {};

  const connection = subscriptions.get(wsId);
  if (!connection) {
    console.error(`[REQ] WebSocket not found for wsId: ${wsId}`);
    return;
  }

  // Check the REQ rate limiter
  if (!reqRateLimiter.removeToken()) {
    console.error(
      `REQ rate limit exceeded for subscriptionId: ${subscriptionId}`
    );
    sendError(wsId, "REQ message rate limit exceeded. Please slow down.");
    sendEOSE(wsId, subscriptionId);
    return;
  }

  // Block unsupported filters
  const unsupportedFilters = ["since", "until"];
  for (const filter of unsupportedFilters) {
    if (filters[filter]) {
      console.error(
        `Unsupported filter '${filter}' used in subscriptionId: ${subscriptionId}`
      );
      sendError(wsId, `Unsupported filter: '${filter}'`);
      sendEOSE(wsId, subscriptionId);
      return;
    }
  }

  // Validate event IDs if present in filters
  try {
    if (filters.ids) {
      validateIds(filters.ids);
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(
        `Invalid event ID format in subscriptionId: ${subscriptionId} - ${error.message}`
      );
      sendError(wsId, `Invalid event ID format: ${error.message}`);
    } else {
      console.error(
        `Invalid event ID format in subscriptionId: ${subscriptionId}`
      );
      sendError(wsId, "Invalid event ID format");
    }
    sendEOSE(wsId, subscriptionId);
    return;
  }

  // Validate author(s) pubkey(s) if present in filters
  try {
    if (filters.authors) {
      validateAuthors(filters.authors);
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(
        `Invalid author public key format in subscriptionId: ${subscriptionId} - ${error.message}`
      );
      sendError(wsId, `Invalid author public key format: ${error.message}`);
    } else {
      console.error(
        `Invalid author public key format in subscriptionId: ${subscriptionId}`
      );
      sendError(wsId, "Invalid author public key format");
    }
    sendEOSE(wsId, subscriptionId);
    return;
  }

  // Check if event kinds are allowed
  if (filters.kinds) {
    const invalidKinds = filters.kinds.filter(
      (kind) => !isEventKindAllowed(kind)
    );
    if (invalidKinds.length > 0) {
      console.error(
        `Blocked kinds in subscriptionId: ${subscriptionId} - ${invalidKinds.join(
          ", "
        )}`
      );
      sendError(wsId, `Blocked kinds in request: ${invalidKinds.join(", ")}`);
      sendEOSE(wsId, subscriptionId);
      return;
    }
  }

  // Allow up to 50 event IDs
  if (filters.ids && filters.ids.length > 50) {
    console.error(
      `Too many event IDs in subscriptionId: ${subscriptionId} - Maximum is 50`
    );
    sendError(wsId, "The 'ids' filter must contain 50 or fewer event IDs.");
    sendEOSE(wsId, subscriptionId);
    return;
  }

  // Allow up to a limit of 50 events
  if (filters.limit && filters.limit > 50) {
    console.error(
      `REQ limit exceeded in subscriptionId: ${subscriptionId} - Maximum allowed is 50`
    );
    sendError(wsId, "REQ limit exceeded. Maximum allowed limit is 50.");
    sendEOSE(wsId, subscriptionId);
    return;
  }

  // If no limit is provided, set it to 50
  filters.limit = filters.limit || 50;

  // Store the subscription in cache
  relayCache.addSubscription(wsId, subscriptionId, filters);

  // Generate a unique cache key based on the filters
  const cacheKey = `req:${JSON.stringify(filters)}`;
  const cachedEvents = relayCache.get(cacheKey);

  // Serve cached events if available
  if (cachedEvents && cachedEvents.length > 0) {
    console.log(`Serving cached events for subscriptionId: ${subscriptionId}`);
    for (const event of cachedEvents.slice(0, filters.limit)) {
      connection.ws.send(JSON.stringify(["EVENT", subscriptionId, event]));
    }
    sendEOSE(wsId, subscriptionId);
    return;
  }

  try {
    // Distribute filters to helper workers
    const shuffledHelpers = shuffleArray([...reqHelpers]);
    const numHelpers = Math.min(shuffledHelpers.length, 6);
    const filterChunks = splitFilters(filters, numHelpers);

    // Collect promises for helper requests
    const helperPromises = filterChunks.map((helperFilters, i) => {
      const helper = shuffledHelpers[i];
      return fetchEventsFromHelper(helper, subscriptionId, helperFilters, env);
    });

    // Await all events from the helper workers
    const fetchedEventsArrays = await Promise.all(helperPromises);
    const events = fetchedEventsArrays.flat();

    // Cache the events if we have any
    if (events.length > 0) {
      relayCache.set(cacheKey, events, 60000); // Cache for 60 seconds
    }

    // Send the events to the client after all helpers have completed
    for (const event of events.slice(0, filters.limit)) {
      connection.ws.send(JSON.stringify(["EVENT", subscriptionId, event]));
    }
    sendEOSE(wsId, subscriptionId);
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(
      `Error fetching events for subscriptionId: ${subscriptionId} - ${errorMessage}`
    );
    sendError(wsId, `Error fetching events: ${errorMessage}`);
    sendEOSE(wsId, subscriptionId);
  }
}

// Handles CLOSE messages
async function closeSubscription(subscriptionId: string, wsId: string) {
  relayCache.deleteSubscription(wsId, subscriptionId);
}

// validateNIP05FromKind0
async function validateNIP05FromKind0(
  pubkey: string,
  env: Bindings
): Promise<boolean> {
  try {
    // Check if we have a kind 0 event cached for the pubkey
    let metadataEvent: NostrEvent | null = relayCache.get(`metadata:${pubkey}`);

    if (!metadataEvent) {
      // If not cached, fetch the kind 0 event from the helper or fallback relay
      metadataEvent = await fetchKind0EventForPubkey(pubkey, env);
      if (!metadataEvent) {
        console.error(`No kind 0 metadata event found for pubkey: ${pubkey}`);
        return false;
      }

      // Cache the event for future reference
      relayCache.set(`metadata:${pubkey}`, metadataEvent, 3600000); // Cache for 1 hour
    }

    // Parse the content field of the kind 0 event
    const metadata = JSON.parse(metadataEvent.content);
    const nip05Address = metadata.nip05;

    if (!nip05Address) {
      console.error(`No NIP-05 address found in kind 0 for pubkey: ${pubkey}`);
      return false;
    }

    // Validate the NIP-05 address
    const isValid = await validateNIP05(nip05Address, pubkey);
    return isValid;
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(
      `Error validating NIP-05 for pubkey ${pubkey}: ${errorMessage}`
    );
    return false;
  }
}

// fetchKind0EventForPubkey
async function fetchKind0EventForPubkey(
  pubkey: string,
  env: Bindings
): Promise<NostrEvent | null> {
  try {
    // Shuffle helpers and distribute the request to fetch kind 0
    const shuffledHelpers = shuffleArray([...reqHelpers]);
    const filters: Filters = { kinds: [0], authors: [pubkey], limit: 1 };

    // Try fetching from helper workers first
    for (const helper of shuffledHelpers) {
      const events = await fetchEventsFromHelper(helper, null, filters, env);
      if (events && events.length > 0) {
        return events[0];
      }
    }

    // If no event found from helpers, use fallback relay
    console.log(
      `No kind 0 event found from helpers, trying fallback relay: wss://relay.nostr.band`
    );
    const fallbackEvent = await fetchEventFromFallbackRelay(pubkey);
    if (fallbackEvent) {
      return fallbackEvent;
    }
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(
      `Error fetching kind 0 event for pubkey ${pubkey}: ${errorMessage}`
    );
  }

  return null;
}

// validateNIP05
async function validateNIP05(
  nip05Address: string,
  pubkey: string
): Promise<boolean> {
  try {
    // Extract the domain and username
    const [name, domain] = nip05Address.split("@");

    if (!domain) {
      throw new Error(`Invalid NIP-05 address format: ${nip05Address}`);
    }

    // Check if the domain is in the blocked list
    if (blockedNip05Domains.has(domain)) {
      console.error(`NIP-05 domain is blocked: ${domain}`);
      return false;
    }

    // If allowed domains are defined, check if the domain is in the allowed list
    if (allowedNip05Domains.size > 0 && !allowedNip05Domains.has(domain)) {
      console.error(`NIP-05 domain is not allowed: ${domain}`);
      return false;
    }

    // Fetch the NIP-05 .well-known/nostr.json file
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(
      name
    )}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(
        `Failed to fetch NIP-05 data from ${url}: ${response.statusText}`
      );
      return false;
    }

    const nip05Data = (await response.json()) as {
      names?: Record<string, string>;
    };

    if (!nip05Data.names || !nip05Data.names[name]) {
      console.error(
        `NIP-05 data does not contain a matching public key for ${name}`
      );
      return false;
    }

    // Compare the pubkey from NIP-05 with the event's pubkey
    const nip05Pubkey = nip05Data.names[name];
    return nip05Pubkey === pubkey;
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`Error validating NIP-05 address: ${error.message}`);
    } else {
      console.error("Error validating NIP-05 address: Unknown error");
    }
    return false;
  }
}

// fetchEventFromFallbackRelay
async function fetchEventFromFallbackRelay(
  pubkey: string
): Promise<NostrEvent | null> {
  return new Promise((resolve, reject) => {
    const fallbackRelayUrl = "wss://relay.nostr.band";
    const ws = new WebSocket(fallbackRelayUrl);
    let hasClosed = false;

    const closeWebSocket = (subscriptionId: string | null) => {
      if (!hasClosed && ws.readyState === WebSocket.OPEN) {
        if (subscriptionId) {
          ws.send(JSON.stringify(["CLOSE", subscriptionId]));
        }
        ws.close();
        hasClosed = true;
        console.log("WebSocket connection to fallback relay closed");
      }
    };

    ws.addEventListener("open", () => {
      console.log("WebSocket connection to fallback relay opened.");
      const subscriptionId = Math.random().toString(36).substr(2, 9);
      const filters = {
        kinds: [0],
        authors: [pubkey],
        limit: 1,
      };
      const reqMessage = JSON.stringify(["REQ", subscriptionId, filters]);
      ws.send(reqMessage);
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data.toString());

        if (message[0] === "EVENT" && message[1]) {
          const eventData: NostrEvent = message[2];
          if (eventData.kind === 0 && eventData.pubkey === pubkey) {
            console.log("Received kind 0 event from fallback relay.");
            closeWebSocket(message[1]);
            resolve(eventData);
          }
        } else if (message[0] === "EOSE") {
          console.log(
            "EOSE received from fallback relay, no kind 0 event found."
          );
          closeWebSocket(message[1]);
          resolve(null);
        }
      } catch (error) {
        console.error(
          `Error processing fallback relay event for pubkey ${pubkey}: ${
            (error as Error).message
          }`
        );
        reject(error);
      }
    });

    ws.addEventListener("error", (error: Event) => {
      const wsError = error as ErrorEvent;
      console.error(`WebSocket error with fallback relay: ${wsError.message}`);
      ws.close();
      hasClosed = true;
      reject(wsError);
    });

    ws.addEventListener("close", () => {
      hasClosed = true;
      console.log("Fallback relay WebSocket connection closed.");
    });
    setTimeout(() => {
      if (!hasClosed) {
        console.log(
          "Timeout reached. Closing WebSocket connection to fallback relay."
        );
        closeWebSocket(null);
        reject(
          new Error(`No response from fallback relay for pubkey ${pubkey}`)
        );
      }
    }, 10000);
  });
}

// fetchEventsFromHelper
async function fetchEventsFromHelper(
  helper: string,
  subscriptionId: string | null,
  filters: Filters,
  env: Bindings
): Promise<NostrEvent[]> {
  const logContext = {
    helper,
    subscriptionId,
    filters,
  };

  try {
    console.log(`Requesting events from helper worker`, logContext);

    const response = await withConnectionLimit(() =>
      fetch(helper, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.AUTH_TOKEN}`,
        },
        body: JSON.stringify({ type: "REQ", subscriptionId, filters }),
      })
    );

    if (response.ok) {
      const contentType = response.headers.get("Content-Type");
      let events: NostrEvent[];

      if (contentType && contentType.includes("application/json")) {
        events = await response.json();
      } else {
        const arrayBuffer = await response.arrayBuffer();
        const textDecoder = new TextDecoder("utf-8");
        const jsonString = textDecoder.decode(arrayBuffer);

        try {
          events = JSON.parse(jsonString);
        } catch (error) {
          console.error("Error parsing ArrayBuffer to JSON:", error);
          throw new Error("Failed to parse response as JSON.");
        }
      }
      console.log(`Successfully retrieved events from helper worker`, {
        ...logContext,
        eventCount: events.length,
      });
      return events;
    } else {
      console.error(`Error fetching events from helper worker`, {
        ...logContext,
        status: response.status,
        statusText: response.statusText,
      });
      throw new Error(
        `Failed to fetch events: ${response.status} - ${response.statusText}`
      );
    }
  } catch (error) {
    console.error(`Error in fetchEventsFromHelper`, {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// sendEventToHelper
async function sendEventToHelper(event: NostrEvent, env: Bindings) {
  const randomHelper =
    eventHelpers[Math.floor(Math.random() * eventHelpers.length)];
  const logContext = {
    helper: randomHelper,
    eventId: event.id,
    pubkey: event.pubkey,
  };

  try {
    console.log(`Sending event to helper worker`, logContext);

    const response = await withConnectionLimit(() =>
      fetch(randomHelper, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.AUTH_TOKEN}`,
        },
        body: JSON.stringify({ type: "EVENT", event }),
      })
    );

    if (response.ok) {
      console.log(`Successfully sent event to helper worker`, logContext);
    } else {
      console.error(`Error sending event to helper worker`, {
        ...logContext,
        status: response.status,
        statusText: response.statusText,
      });
    }
  } catch (error) {
    console.error(`Error in sendEventToHelper`, {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// matchesFilters
function matchesFilters(event: NostrEvent, filters: Filters): boolean {
  // Check 'ids' filter
  if (filters.ids && !filters.ids.includes(event.id)) return false;

  // Check 'authors' filter
  if (filters.authors && !filters.authors.includes(event.pubkey)) return false;

  // Check 'kinds' filter
  if (filters.kinds && !filters.kinds.includes(event.kind)) return false;

  // Check 'since' filter
  if (filters.since && event.created_at < filters.since) return false;

  // Check 'until' filter
  if (filters.until && event.created_at > filters.until) return false;

  // Check tag filters (e.g., '#e', '#p')
  for (const [filterKey, filterValues] of Object.entries(filters)) {
    if (filterKey.startsWith("#")) {
      const tagKey = filterKey.slice(1);
      const eventTags = event.tags
        .filter((tag) => tag[0] === tagKey)
        .map((tag) => tag[1]);
      if (!filterValues.some((value: string) => eventTags.includes(value))) {
        return false;
      }
    }
  }

  return true;
}

// splitFilters
function splitFilters(filters: Filters, numChunks: number): Filters[] {
  const baseFilters: Filters = {};
  const arrayFilters: Record<string, any[]> = {};

  // Separate base filters and array filters
  for (const key in filters) {
    if (Array.isArray(filters[key])) {
      arrayFilters[key] = filters[key];
    } else {
      baseFilters[key] = filters[key];
    }
  }

  // Single kind or single author do not split
  if (
    arrayFilters.kinds &&
    arrayFilters.kinds.length <= 1 &&
    (!arrayFilters.authors || arrayFilters.authors.length <= 1)
  ) {
    return [filters];
  }

  // Otherwise, split the filters across chunks
  const filterChunks: Filters[] = Array(numChunks)
    .fill(null)
    .map(() => ({ ...baseFilters }));
  const arrayKeys = Object.keys(arrayFilters);

  if (arrayKeys.length === 1) {
    const key = arrayKeys[0];
    const arrayValues = arrayFilters[key];
    const arrayChunks = splitArray(arrayValues, numChunks);
    for (let i = 0; i < numChunks; i++) {
      filterChunks[i][key] = arrayChunks[i];
    }
  } else {
    for (const key in arrayFilters) {
      const arrayValues = arrayFilters[key];
      if (key === "authors") {
        const arrayChunks = splitArray(arrayValues, numChunks);
        for (let i = 0; i < numChunks; i++) {
          filterChunks[i][key] = arrayChunks[i];
        }
      } else {
        for (let i = 0; i < numChunks; i++) {
          filterChunks[i][key] = arrayValues;
        }
      }
    }
  }

  return filterChunks;
}

// splitArray
function splitArray<T>(array: T[], numChunks: number): T[][] {
  const chunks: T[][] = Array.from({ length: numChunks }, () => []);
  for (let i = 0; i < array.length; i++) {
    chunks[i % numChunks].push(array[i]);
  }
  return chunks;
}

// shuffleArray
function shuffleArray<T>(array: T[]): T[] {
  const shuffledArray = array.slice(); // Create a copy
  for (let i = shuffledArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledArray[i], shuffledArray[j]] = [shuffledArray[j], shuffledArray[i]];
  }
  return shuffledArray;
}

// validateIds
function validateIds(ids: string[]) {
  for (const id of ids) {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error(`Invalid event ID format: ${id}`);
    }
  }
}

// validateAuthors
function validateAuthors(authors: string[]) {
  for (const author of authors) {
    if (!/^[a-f0-9]{64}$/.test(author)) {
      throw new Error(`Invalid author pubkey format: ${author}`);
    }
  }
}

// sendOK
function sendOK(
  wsId: string,
  eventId: string | null,
  status: boolean,
  message: string
) {
  const connection = subscriptions.get(wsId);
  if (connection) {
    connection.ws.send(JSON.stringify(["OK", eventId, status, message]));
  } else {
    console.error(`WebSocket not found for wsId: ${wsId}`);
  }
}

// sendError
function sendError(wsId: string, message: string) {
  const connection = subscriptions.get(wsId);
  if (connection) {
    connection.ws.send(JSON.stringify(["NOTICE", message]));
  } else {
    console.error(`WebSocket not found for wsId: ${wsId}`);
  }
}

// sendEOSE
function sendEOSE(wsId: string, subscriptionId: string) {
  const connection = subscriptions.get(wsId);
  if (connection) {
    connection.ws.send(JSON.stringify(["EOSE", subscriptionId]));
  } else {
    console.error(`WebSocket not found for wsId: ${wsId}`);
  }
}

// verifyEventSignature
async function verifyEventSignature(event: NostrEvent) {
  try {
    const signatureBytes = hexToBytes(event.sig);
    const serializedEventData = serializeEventForSigning(event);
    const messageHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(serializedEventData)
    );
    const messageHash = new Uint8Array(messageHashBuffer);
    const publicKeyBytes = hexToBytes(event.pubkey);
    const signatureIsValid = schnorr.verify(
      signatureBytes,
      messageHash,
      publicKeyBytes
    );
    return signatureIsValid;
  } catch (error) {
    console.error("Error verifying event signature:", error);
    return false;
  }
}

function serializeEventForSigning(event: NostrEvent): string {
  const serializedEvent = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return serializedEvent;
}

function hexToBytes(hexString: string): Uint8Array {
  if (hexString.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexString.substr(i * 2, 2), 16);
  }
  return bytes;
}
