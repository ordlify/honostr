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

// Initialize a new Hono application with custom bindings
const app = new Hono<{ Bindings: Bindings }>();

/**
 * Checks if a given public key is allowed based on allowed and blocked lists.
 * @param pubkey - The public key to check.
 * @returns `true` if the pubkey is allowed, `false` otherwise.
 */
function isPubkeyAllowed(pubkey: string): boolean {
  // If there are allowed pubkeys specified and the current pubkey is not in the allowed list, deny it
  if (allowedPubkeys.size > 0 && !allowedPubkeys.has(pubkey)) {
    return false;
  }
  // Deny the pubkey if it's in the blocked list
  return !blockedPubkeys.has(pubkey);
}

/**
 * Checks if a given event kind is allowed based on allowed and blocked lists.
 * @param kind - The event kind to check.
 * @returns `true` if the event kind is allowed, `false` otherwise.
 */
function isEventKindAllowed(kind: number): boolean {
  // If there are allowed event kinds specified and the current kind is not in the allowed list, deny it
  if (allowedEventKinds.size > 0 && !allowedEventKinds.has(kind)) {
    return false;
  }
  // Deny the event kind if it's in the blocked list
  return !blockedEventKinds.has(kind);
}

/**
 * Determines if an event contains any blocked content in its content or tags.
 * @param event - The Nostr event to check.
 * @returns `true` if blocked content is found, `false` otherwise.
 */
function containsBlockedContent(event: NostrEvent): boolean {
  // Convert content and tags to lowercase for case-insensitive comparison
  const lowercaseContent = (event.content || "").toLowerCase();
  const lowercaseTags = event.tags.map((tag) => tag.join("").toLowerCase());

  // Iterate through each blocked phrase and check for its presence
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

/**
 * Checks if a given tag is allowed based on allowed and blocked lists.
 * @param tag - The tag to check.
 * @returns `true` if the tag is allowed, `false` otherwise.
 */
function isTagAllowed(tag: string): boolean {
  // If there are allowed tags specified and the current tag is not in the allowed list, deny it
  if (allowedTags.size > 0 && !allowedTags.has(tag)) {
    return false;
  }
  // Deny the tag if it's in the blocked list
  return !blockedTags.has(tag);
}

// In-memory cache and subscription management object
const relayCache = {
  // Cache storage with key-value pairs
  _cache: new Map<string, any>(),
  // Subscription storage with wsId as key and a map of subscriptionId to Filters
  _subscriptions: new Map<string, Map<string, Filters>>(),

  /**
   * Retrieves a cached value if it exists and hasn't expired.
   * @param key - The key to retrieve from the cache.
   * @returns The cached value or `null` if not found or expired.
   */
  get(key: string) {
    const item = this._cache.get(key);
    if (item && item.expires > Date.now()) {
      return item.value;
    }
    return null;
  },

  /**
   * Stores a value in the cache with an optional TTL (Time To Live).
   * @param key - The key under which to store the value.
   * @param value - The value to store.
   * @param ttl - Time in milliseconds before the cache entry expires (default: 60,000 ms).
   */
  set(key: string, value: any, ttl = 60000) {
    this._cache.set(key, {
      value,
      expires: Date.now() + ttl,
    });
  },

  /**
   * Deletes a key-value pair from the cache.
   * @param key - The key to delete from the cache.
   */
  delete(key: string) {
    this._cache.delete(key);
  },

  /**
   * Adds a subscription to the subscriptions map.
   * @param wsId - The WebSocket ID associated with the connection.
   * @param subscriptionId - The unique ID for the subscription.
   * @param filters - The filters associated with the subscription.
   */
  addSubscription(wsId: string, subscriptionId: string, filters: Filters) {
    if (!this._subscriptions.has(wsId)) {
      this._subscriptions.set(wsId, new Map());
    }
    this._subscriptions.get(wsId)!.set(subscriptionId, filters);
  },

  /**
   * Retrieves a specific subscription based on wsId and subscriptionId.
   * @param wsId - The WebSocket ID associated with the connection.
   * @param subscriptionId - The unique ID for the subscription.
   * @returns The Filters object or `null` if not found.
   */
  getSubscription(wsId: string, subscriptionId: string) {
    return this._subscriptions.get(wsId)?.get(subscriptionId) || null;
  },

  /**
   * Deletes a specific subscription based on wsId and subscriptionId.
   * @param wsId - The WebSocket ID associated with the connection.
   * @param subscriptionId - The unique ID for the subscription.
   */
  deleteSubscription(wsId: string, subscriptionId: string) {
    this._subscriptions.get(wsId)?.delete(subscriptionId);
  },

  /**
   * Clears all subscriptions associated with a given wsId.
   * @param wsId - The WebSocket ID whose subscriptions are to be cleared.
   */
  clearSubscriptions(wsId: string) {
    this._subscriptions.delete(wsId);
  },
};

/**
 * A RateLimiter class implementing the Token Bucket algorithm to control action rates.
 */
class RateLimiter {
  tokens: number; // Current number of tokens available
  lastRefillTime: number; // Timestamp of the last token refill
  capacity: number; // Maximum number of tokens
  fillRate: number; // Token refill rate (tokens per millisecond)

  /**
   * Initializes a new RateLimiter instance.
   * @param rate - The rate at which tokens are added (tokens per millisecond).
   * @param capacity - The maximum number of tokens in the bucket.
   */
  constructor(rate: number, capacity: number) {
    this.tokens = capacity;
    this.lastRefillTime = Date.now();
    this.capacity = capacity;
    this.fillRate = rate;
  }

  /**
   * Attempts to remove a token from the bucket.
   * @returns `true` if a token was removed, `false` if rate limit is exceeded.
   */
  removeToken() {
    this.refill();
    if (this.tokens < 1) {
      return false; // No tokens available, rate limit exceeded
    }
    this.tokens -= 1;
    return true;
  }

  /**
   * Refills tokens based on the elapsed time since the last refill.
   */
  refill() {
    const now = Date.now();
    const elapsedTime = now - this.lastRefillTime;
    const tokensToAdd = Math.floor(elapsedTime * this.fillRate);
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }
}

// Initialize rate limiters for pubkey EVENT messages and REQ messages
const pubkeyRateLimiter = new RateLimiter(10 / 60000, 10); // 10 EVENT messages per minute
const reqRateLimiter = new RateLimiter(10 / 60000, 10); // 10 REQ messages per minute

// Array of event kinds to exclude from EVENT rate limiting (e.g., kind 1)
const excludedRateLimitKinds: number[] = [1];

// Maximum number of concurrent helper worker connections
const MAX_CONCURRENT_CONNECTIONS = 6;
let activeConnections = 0;

/**
 * Controls the number of concurrent connections to helper workers.
 * Ensures that the number of active connections does not exceed the specified limit.
 * @param promiseFunction - The async function representing the helper worker request.
 * @returns The result of the promiseFunction.
 */
async function withConnectionLimit<T>(
  promiseFunction: () => Promise<T>
): Promise<T> {
  // Wait if the number of active connections has reached the maximum
  while (activeConnections >= MAX_CONCURRENT_CONNECTIONS) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Increment active connections before making the request
  activeConnections += 1;
  try {
    return await promiseFunction();
  } finally {
    // Decrement active connections after the request completes
    activeConnections -= 1;
  }
}

// Map to store active WebSocket subscriptions with wsId as the key
const subscriptions = new Map<
  string,
  {
    ws: WSContext<WebSocket>;
    filters: Map<string, Filters>;
  }
>();

// Hono route handlers

/**
 * WebSocket route at the root path ("/").
 * Upgrades HTTP requests to WebSocket connections using the handleWebSocket function.
 */
app.get("/", upgradeWebSocket(handleWebSocket));

/**
 * HTTP GET route at the root path ("/").
 * Returns relay information in Nostr JSON format or a plain text message based on the Accept header.
 * @param c - The Hono context.
 * @returns A JSON response with relay info or a plain text message.
 */
app.get("/", async (c) => {
  const acceptHeader = c.req.header("Accept");

  if (acceptHeader && acceptHeader.includes("application/nostr+json")) {
    return handleRelayInfoRequest(c);
  } else {
    return c.text("Connect using a Nostr client");
  }
});

/**
 * HTTP GET route for '/.well-known/nostr.json'.
 * Handles NIP-05 requests for user verification.
 * @param c - The Hono context.
 * @returns A JSON response with NIP-05 verification data.
 */
app.get("/.well-known/nostr.json", async (c) => {
  return handleNIP05Request(c);
});

/**
 * HTTP GET route for '/favicon.ico'.
 * Serves the relay's favicon.
 * @param c - The Hono context.
 * @returns The favicon image or a 404 Not Found response.
 */
app.get("/favicon.ico", async (c) => {
  return serveFavicon(c);
});

// Export the Hono app as the default export
export default app;

/**
 * Handles Relay Info Requests.
 * Responds with relay information in Nostr JSON format.
 * @param c - The Hono context.
 * @returns A JSON response with relay info and appropriate headers.
 */
async function handleRelayInfoRequest(c: Context) {
  const headers = {
    "Content-Type": "application/nostr+json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Allow-Methods": "GET",
  };
  return c.json(relayInfo, 200, headers);
}

/**
 * Serves the relay's favicon.
 * Fetches the favicon from a specified URL and sets caching headers.
 * @param c - The Hono context.
 * @returns The favicon image or a 404 Not Found response.
 */
async function serveFavicon(c: Context) {
  const response = await fetch(relayIcon);
  if (response.ok) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "max-age=3600"); // Cache favicon for 1 hour
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }
  return c.text("Not found", 404);
}

/**
 * Handles NIP-05 Requests for user verification.
 * Responds with NIP-05 verification data based on the provided 'name' parameter.
 * @param c - The Hono context.
 * @returns A JSON response with NIP-05 verification data or an error message.
 */
async function handleNIP05Request(c: Context) {
  const url = new URL(c.req.url);
  const name = url.searchParams.get("name");

  // Validate that the 'name' parameter is provided
  if (!name) {
    return c.json({ error: "Missing 'name' parameter" }, 400);
  }

  // Retrieve the pubkey associated with the provided name
  const pubkey = nip05Users[name.toLowerCase()];
  if (!pubkey) {
    return c.json({ error: "User not found" }, 404);
  }

  // Construct the NIP-05 response with the user's pubkey and associated relays
  const response = {
    names: {
      [name]: pubkey,
    },
    relays: {
      [pubkey]: [
        // Add relays for NIP-05 users here
      ],
    },
  };

  // Respond with the constructed NIP-05 data
  return c.json(response, 200, {
    "Access-Control-Allow-Origin": "*",
  });
}

/**
 * Handles WebSocket connections.
 * Manages the lifecycle of WebSocket connections, including message handling,
 * subscription management, and error handling.
 * @param c - The Hono context containing environment bindings.
 * @returns An object with WebSocket event handlers: onMessage, onClose, onError.
 */
function handleWebSocket(c: Context<{ Bindings: Bindings }>) {
  const env = c.env;

  // Generate a unique WebSocket ID for the connection
  // Delayed initialization ensures wsId is only generated when needed
  let wsId: string | null = null;

  // Flag to ensure that initialization happens only once per connection
  let initialized = false;

  return {
    /**
     * Handler for incoming WebSocket messages.
     * Processes messages based on their type (EVENT, REQ, CLOSE).
     * @param evt - The message event containing data from the client.
     * @param ws - The WebSocket context.
     */
    onMessage(evt: MessageEvent, ws: WSContext<WebSocket>): void {
      (async () => {
        try {
          // Initialize the subscription if not already done
          if (!initialized) {
            // Generate wsId upon first message to avoid unnecessary IDs
            wsId = crypto.randomUUID();
            // Store the subscription with minimal necessary data
            subscriptions.set(wsId, {
              ws,
              filters: new Map(),
            });
            initialized = true;
            console.log(`[WS] Subscription initialized for wsId: ${wsId}`);
          }

          let messageData: any;

          // Decode the incoming message based on its type
          if (evt.data instanceof ArrayBuffer) {
            const textDecoder = new TextDecoder("utf-8");
            const decodedText = textDecoder.decode(evt.data);
            messageData = JSON.parse(decodedText);
          } else if (typeof evt.data === "string") {
            messageData = JSON.parse(evt.data);
          } else {
            console.warn(`[WS] Unsupported message type from wsId: ${wsId}`);
            sendError(wsId!, "Unsupported message type");
            return;
          }

          // Validate that the message is a non-empty array
          if (!Array.isArray(messageData) || messageData.length === 0) {
            console.warn(`[WS] Invalid message format from wsId: ${wsId}`);
            sendError(wsId!, "Invalid message format");
            return;
          }

          const messageType = messageData[0];
          console.log(`[WS] Received ${messageType} message for wsId: ${wsId}`);

          // Handle different message types
          switch (messageType) {
            case "EVENT":
              // Handle incoming EVENT messages
              await processEvent(messageData[1], wsId!, env);
              break;
            case "REQ":
              // Handle subscription REQ messages
              await processReq(messageData, wsId!, env);
              break;
            case "CLOSE":
              // Handle subscription CLOSE messages
              await closeSubscription(messageData[1], wsId!);
              break;
            default:
              // Handle unknown message types
              console.warn(
                `[WS] Unknown message type "${messageType}" from wsId: ${wsId}`
              );
              sendError(wsId!, `Unknown message type: ${messageType}`);
          }
        } catch (e) {
          // Log and notify the client of any processing errors
          console.error(`[WS] Error processing message for wsId ${wsId}:`, e);
          sendError(wsId!, "Failed to process the message");
        }
      })();
    },

    /**
     * Handler for WebSocket connection closing.
     * Cleans up subscriptions associated with the wsId.
     * @param evt - The close event.
     * @param ws - The WebSocket context.
     */
    onClose(evt: CloseEvent, ws: WSContext<WebSocket>) {
      if (wsId) {
        console.log(`[WS] Closing connection for wsId: ${wsId}`);
        // Remove the subscription from the global subscriptions map
        subscriptions.delete(wsId);
        console.log(`[WS] Remaining connections: ${subscriptions.size}`);
      } else {
        console.log(`[WS] Connection closed without initialization.`);
      }
    },

    /**
     * Handler for WebSocket errors.
     * Cleans up subscriptions associated with the wsId.
     * @param evt - The error event.
     * @param ws - The WebSocket context.
     */
    onError(evt: Event, ws: WSContext<WebSocket>) {
      if (wsId) {
        console.error(`[WS] Error for wsId ${wsId}:`, evt);
        // Remove the subscription from the global subscriptions map
        subscriptions.delete(wsId);
      } else {
        console.error(`[WS] Error for unknown wsId:`, evt);
      }
    },
  };
}

/**
 * Processes incoming EVENT messages from clients.
 * Validates the event, checks for duplicates, verifies signatures,
 * caches the event, acknowledges the client, and processes the event in the background.
 * @param event - The Nostr event to process.
 * @param wsId - The WebSocket ID associated with the connection.
 * @param env - The environment bindings.
 */
async function processEvent(event: NostrEvent, wsId: string, env: Bindings) {
  try {
    // Validate that the event is a proper JSON object
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      console.error(
        `[Event] Invalid JSON format for event: ${JSON.stringify(
          event
        )}. Expected a JSON object.`
      );
      sendOK(wsId, null, false, "Invalid JSON format. Expected a JSON object.");
      return;
    }

    // Log the start of event processing
    console.log(`[Event] Processing event ${event.id}`);

    // Check the cache for duplicate event IDs to prevent processing the same event multiple times
    const cacheKey = `event:${event.id}`;
    const cachedEvent = relayCache.get(cacheKey);
    if (cachedEvent) {
      console.log(
        `[Event] Duplicate event detected: ${event.id}. Dropping event.`
      );
      sendOK(wsId, event.id, false, "Duplicate. Event dropped.");
      return;
    }

    // Verify the event's signature to ensure authenticity
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

    // Add the event to the cache with a TTL of 60 seconds to prevent duplicates
    relayCache.set(cacheKey, event, 60000);
    console.log(`[Event] Event ${event.id} cached with a TTL of 60 seconds`);

    // Acknowledge the event receipt to the client
    sendOK(wsId, event.id, true, "Event received successfully for processing.");
    console.log(`[Event] Event ${event.id} acknowledged to the client`);

    // Process the event asynchronously to handle further actions like distribution
    processEventInBackground(event, wsId, env);
  } catch (error) {
    // Handle any errors during event processing
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

/**
 * Processes the event asynchronously in the background.
 * Performs additional validations, rate limiting, matches subscriptions, caches events,
 * and forwards the event to helper workers.
 * @param event - The Nostr event to process.
 * @param wsId - The WebSocket ID associated with the connection.
 * @param env - The environment bindings.
 * @returns An object indicating success or failure with an error message if applicable.
 */
async function processEventInBackground(
  event: NostrEvent,
  wsId: string,
  env: Bindings
) {
  // Retrieve the WebSocket connection associated with the wsId
  const connection = subscriptions.get(wsId);
  if (!connection) {
    console.error(`[Event] WebSocket not found for wsId: ${wsId}`);
    return;
  }
  try {
    // Log the start of background event processing
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

    // Check for blocked content in the event
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

    // NIP-05 validation is commented out; uncomment if needed
    // if (event.kind !== 0) {
    //   const isValidNIP05 = await validateNIP05FromKind0(event.pubkey, env);
    //   if (!isValidNIP05) {
    //     console.error(
    //       `[Event] Event denied. NIP-05 validation failed for pubkey ${event.pubkey}.`
    //     );
    //     return {
    //       success: false,
    //       error: `NIP-05 validation failed for pubkey ${event.pubkey}.`,
    //     };
    //   }
    // }

    // Apply rate limiting to all event kinds except those excluded
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

    // Retrieve subscriptions associated with the wsId from relayCache
    const subscriptions = relayCache._subscriptions.get(wsId);

    if (subscriptions) {
      let matched = false;
      // Iterate through each subscription and check if the event matches the filters
      for (const [subscriptionId, filters] of subscriptions.entries()) {
        if (matchesFilters(event, filters)) {
          matched = true;
          console.log(
            `[Event] Event ${event.id} matched subscription ${subscriptionId}`
          );
          // Send the event to the matching subscription
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
          // Cache the events for 60 seconds
          relayCache.set(cacheKey, cachedEvents, 60000);
        }
      }
    }

    // Forward the event to helper workers for distribution
    console.log(`[Event] Forwarding event ${event.id} to helper workers`);
    await sendEventToHelper(event, env);
  } catch (error: unknown) {
    // Handle any errors during background event processing
    if (error instanceof Error) {
      console.error("[Event] Error in background event processing:", error);
      return { success: false, error: `Error: ${error.message}` };
    } else {
      console.error("[Event] Error in background event processing:", error);
      return { success: false, error: "An unknown error occurred" };
    }
  }
}

/**
 * Processes incoming REQ messages from clients.
 * Validates the request, applies rate limiting, handles filters,
 * fetches events from helper workers, caches results, and responds to the client.
 * @param message - The REQ message data array.
 * @param wsId - The WebSocket ID associated with the connection.
 * @param env - The environment bindings.
 */
async function processReq(message: any, wsId: string, env: Bindings) {
  const subscriptionId = message[1]; // Extract subscription ID from the message
  const filters: Filters = message[2] || {}; // Extract filters from the message

  // Retrieve the WebSocket connection associated with the wsId
  const connection = subscriptions.get(wsId);
  if (!connection) {
    console.error(`[REQ] WebSocket not found for wsId: ${wsId}`);
    return;
  }

  // Check the REQ rate limiter to prevent abuse
  if (!reqRateLimiter.removeToken()) {
    console.error(
      `REQ rate limit exceeded for subscriptionId: ${subscriptionId}`
    );
    sendError(wsId, "REQ message rate limit exceeded. Please slow down.");
    sendEOSE(wsId, subscriptionId);
    return;
  }

  // Define unsupported filters that should be blocked
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

  // Check if event kinds specified in filters are allowed
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

  // Optional: Limit the number of event IDs and events per REQ (commented out)
  // Uncomment and adjust as needed to enforce limits

  // // Allow up to 50 event IDs
  // if (filters.ids && filters.ids.length > 50) {
  //   console.error(
  //     `Too many event IDs in subscriptionId: ${subscriptionId} - Maximum is 50`
  //   );
  //   sendError(wsId, "The 'ids' filter must contain 50 or fewer event IDs.");
  //   sendEOSE(wsId, subscriptionId);
  //   return;
  // }

  // // Allow up to a limit of 50 events
  // if (filters.limit && filters.limit > 50) {
  //   console.error(
  //     `REQ limit exceeded in subscriptionId: ${subscriptionId} - Maximum allowed is 50`
  //   );
  //   sendError(wsId, "REQ limit exceeded. Maximum allowed limit is 50.");
  //   sendEOSE(wsId, subscriptionId);
  //   return;
  // }

  // // If no limit is provided, set it to 50
  // filters.limit = filters.limit || 50;

  // Store the subscription in cache for future reference
  relayCache.addSubscription(wsId, subscriptionId, filters);

  // Generate a unique cache key based on the filters to retrieve cached events
  const cacheKey = `req:${JSON.stringify(filters)}`;
  const cachedEvents = relayCache.get(cacheKey);

  // Serve cached events to the client if available
  if (cachedEvents && cachedEvents.length > 0) {
    console.log(`Serving cached events for subscriptionId: ${subscriptionId}`);
    for (const event of cachedEvents.slice(0, filters.limit)) {
      connection.ws.send(JSON.stringify(["EVENT", subscriptionId, event]));
    }
    sendEOSE(wsId, subscriptionId);
    return;
  }

  try {
    // Distribute filters across helper workers to fetch relevant events
    const shuffledHelpers = shuffleArray([...reqHelpers]);
    const numHelpers = Math.min(shuffledHelpers.length, 6); // Limit to 6 helpers
    const filterChunks = splitFilters(filters, numHelpers);

    // Collect promises for helper worker requests
    const helperPromises = filterChunks.map((helperFilters, i) => {
      const helper = shuffledHelpers[i];
      return fetchEventsFromHelper(helper, subscriptionId, helperFilters, env);
    });

    // Await all events from the helper workers
    const fetchedEventsArrays = await Promise.all(helperPromises);
    const events = fetchedEventsArrays.flat();

    // Cache the retrieved events for future subscriptions
    if (events.length > 0) {
      relayCache.set(cacheKey, events, 60000); // Cache for 60 seconds
    }

    // Send the retrieved events to the client
    for (const event of events.slice(0, filters.limit)) {
      connection.ws.send(JSON.stringify(["EVENT", subscriptionId, event]));
    }
    // Send End of Stored Events (EOSE) message to signify the end of the initial batch
    sendEOSE(wsId, subscriptionId);
  } catch (error: unknown) {
    // Handle any errors during event fetching from helper workers
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(
      `Error fetching events for subscriptionId: ${subscriptionId} - ${errorMessage}`
    );
    sendError(wsId, `Error fetching events: ${errorMessage}`);
    sendEOSE(wsId, subscriptionId);
  }
}

/**
 * Handles CLOSE messages from clients.
 * Removes the specified subscription from the relay cache.
 * @param subscriptionId - The unique ID for the subscription to close.
 * @param wsId - The WebSocket ID associated with the connection.
 */
async function closeSubscription(subscriptionId: string, wsId: string) {
  relayCache.deleteSubscription(wsId, subscriptionId);
}

/**
 * Validates a NIP-05 address by ensuring it matches the pubkey in a kind 0 event.
 * @param pubkey - The public key to validate.
 * @param env - The environment bindings.
 * @returns `true` if the NIP-05 validation succeeds, `false` otherwise.
 */
async function validateNIP05FromKind0(
  pubkey: string,
  env: Bindings
): Promise<boolean> {
  try {
    // Check if a kind 0 event for the pubkey is already cached
    let metadataEvent: NostrEvent | null = relayCache.get(`metadata:${pubkey}`);

    if (!metadataEvent) {
      // If not cached, fetch the kind 0 event from helper workers or fallback relay
      metadataEvent = await fetchKind0EventForPubkey(pubkey, env);
      if (!metadataEvent) {
        console.error(`No kind 0 metadata event found for pubkey: ${pubkey}`);
        return false;
      }

      // Cache the retrieved kind 0 event for 1 hour
      relayCache.set(`metadata:${pubkey}`, metadataEvent, 3600000); // 1 hour in milliseconds
    }

    // Parse the content of the kind 0 event to extract NIP-05 address
    const metadata = JSON.parse(metadataEvent.content);
    const nip05Address = metadata.nip05;

    if (!nip05Address) {
      console.error(`No NIP-05 address found in kind 0 for pubkey: ${pubkey}`);
      return false;
    }

    // Validate the extracted NIP-05 address against the pubkey
    const isValid = await validateNIP05(nip05Address, pubkey);
    return isValid;
  } catch (error: unknown) {
    // Handle any errors during NIP-05 validation
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(
      `Error validating NIP-05 for pubkey ${pubkey}: ${errorMessage}`
    );
    return false;
  }
}

/**
 * Fetches a kind 0 event for a given pubkey from helper workers or a fallback relay.
 * @param pubkey - The public key to fetch the kind 0 event for.
 * @param env - The environment bindings.
 * @returns The fetched Nostr event or `null` if not found.
 */
async function fetchKind0EventForPubkey(
  pubkey: string,
  env: Bindings
): Promise<NostrEvent | null> {
  try {
    // Shuffle helper workers to distribute the load
    const shuffledHelpers = shuffleArray([...reqHelpers]);
    const filters: Filters = { kinds: [0], authors: [pubkey], limit: 1 };

    // Attempt to fetch the kind 0 event from helper workers
    for (const helper of shuffledHelpers) {
      const events = await fetchEventsFromHelper(helper, null, filters, env);
      if (events && events.length > 0) {
        return events[0];
      }
    }

    // If no event is found from helpers, attempt to fetch from a fallback relay
    console.log(
      `No kind 0 event found from helpers, trying fallback relay: wss://relay.nostr.band`
    );
    const fallbackEvent = await fetchEventFromFallbackRelay(pubkey);
    if (fallbackEvent) {
      return fallbackEvent;
    }
  } catch (error: unknown) {
    // Handle any errors during event fetching
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(
      `Error fetching kind 0 event for pubkey ${pubkey}: ${errorMessage}`
    );
  }

  // Return null if no kind 0 event is found
  return null;
}

/**
 * Validates a NIP-05 address by ensuring it matches the provided pubkey.
 * @param nip05Address - The NIP-05 address to validate.
 * @param pubkey - The public key to compare against the NIP-05 address.
 * @returns `true` if the NIP-05 address is valid and matches the pubkey, `false` otherwise.
 */
async function validateNIP05(
  nip05Address: string,
  pubkey: string
): Promise<boolean> {
  try {
    // Split the NIP-05 address into username and domain
    const [name, domain] = nip05Address.split("@");

    if (!domain) {
      throw new Error(`Invalid NIP-05 address format: ${nip05Address}`);
    }

    // Check if the domain is blocked
    if (blockedNip05Domains.has(domain)) {
      console.error(`NIP-05 domain is blocked: ${domain}`);
      return false;
    }

    // If allowed domains are specified, ensure the domain is allowed
    if (allowedNip05Domains.size > 0 && !allowedNip05Domains.has(domain)) {
      console.error(`NIP-05 domain is not allowed: ${domain}`);
      return false;
    }

    // Fetch the NIP-05 verification data from the domain's .well-known/nostr.json
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

    // Parse the fetched NIP-05 data
    const nip05Data = (await response.json()) as {
      names?: Record<string, string>;
    };

    // Check if the fetched data contains a matching pubkey for the username
    if (!nip05Data.names || !nip05Data.names[name]) {
      console.error(
        `NIP-05 data does not contain a matching public key for ${name}`
      );
      return false;
    }

    // Compare the pubkey from NIP-05 with the provided pubkey
    const nip05Pubkey = nip05Data.names[name];
    return nip05Pubkey === pubkey;
  } catch (error: unknown) {
    // Handle any errors during NIP-05 validation
    if (error instanceof Error) {
      console.error(`Error validating NIP-05 address: ${error.message}`);
    } else {
      console.error("Error validating NIP-05 address: Unknown error");
    }
    return false;
  }
}

/**
 * Fetches a kind 0 event from a fallback relay WebSocket connection.
 * @param pubkey - The public key to fetch the kind 0 event for.
 * @returns The fetched Nostr event or `null` if not found.
 */
async function fetchEventFromFallbackRelay(
  pubkey: string
): Promise<NostrEvent | null> {
  return new Promise((resolve, reject) => {
    const fallbackRelayUrl = "wss://relay.nostr.band";
    const ws = new WebSocket(fallbackRelayUrl);
    let hasClosed = false;

    /**
     * Closes the WebSocket connection gracefully.
     * @param subscriptionId - The subscription ID to close, if any.
     */
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

    // Event listener for WebSocket connection open
    ws.addEventListener("open", () => {
      console.log("WebSocket connection to fallback relay opened.");
      // Generate a random subscription ID for the request
      const subscriptionId = Math.random().toString(36).substr(2, 9);
      const filters = {
        kinds: [0],
        authors: [pubkey],
        limit: 1,
      };
      // Send a REQ message to fetch the kind 0 event
      const reqMessage = JSON.stringify(["REQ", subscriptionId, filters]);
      ws.send(reqMessage);
    });

    // Event listener for incoming messages from the fallback relay
    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data.toString());

        if (message[0] === "EVENT" && message[1]) {
          const eventData: NostrEvent = message[2];
          // Check if the received event matches the requested pubkey and kind
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
        // Handle any errors during message processing
        console.error(
          `Error processing fallback relay event for pubkey ${pubkey}: ${
            (error as Error).message
          }`
        );
        reject(error);
      }
    });

    // Event listener for WebSocket errors
    ws.addEventListener("error", (error: Event) => {
      const wsError = error as ErrorEvent;
      console.error(`WebSocket error with fallback relay: ${wsError.message}`);
      ws.close();
      hasClosed = true;
      reject(wsError);
    });

    // Event listener for WebSocket connection close
    ws.addEventListener("close", () => {
      hasClosed = true;
      console.log("Fallback relay WebSocket connection closed.");
    });

    // Set a timeout to close the WebSocket connection if no response is received within 10 seconds
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
    }, 10000); // 10,000 milliseconds = 10 seconds
  });
}

/**
 * Fetches events from a helper worker based on the provided filters.
 * @param helper - The URL of the helper worker to fetch events from.
 * @param subscriptionId - The subscription ID associated with the request, if any.
 * @param filters - The filters to apply when fetching events.
 * @param env - The environment bindings.
 * @returns An array of Nostr events retrieved from the helper worker.
 */
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

    // Make a POST request to the helper worker with the REQ message
    const response = await withConnectionLimit(() =>
      fetch(helper, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.AUTH_TOKEN}`, // Include authorization if required
        },
        body: JSON.stringify({ type: "REQ", subscriptionId, filters }),
      })
    );

    if (response.ok) {
      const contentType = response.headers.get("Content-Type");
      let events: NostrEvent[];

      // Parse the response based on its content type
      if (contentType && contentType.includes("application/json")) {
        events = await response.json();
      } else {
        // If response is not JSON, attempt to parse it from an ArrayBuffer
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
      // Handle HTTP errors from the helper worker
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
    // Handle any network or parsing errors
    console.error(`Error in fetchEventsFromHelper`, {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Sends an EVENT message to a helper worker for further processing or distribution.
 * @param event - The Nostr event to send to the helper worker.
 * @param env - The environment bindings.
 */
async function sendEventToHelper(event: NostrEvent, env: Bindings) {
  // Select a random helper worker from the list
  const randomHelper =
    eventHelpers[Math.floor(Math.random() * eventHelpers.length)];
  const logContext = {
    helper: randomHelper,
    eventId: event.id,
    pubkey: event.pubkey,
  };

  try {
    console.log(`Sending event to helper worker`, logContext);

    // Make a POST request to the helper worker with the EVENT message
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
      // Handle HTTP errors from the helper worker
      console.error(`Error sending event to helper worker`, {
        ...logContext,
        status: response.status,
        statusText: response.statusText,
      });
    }
  } catch (error) {
    // Handle any network or other errors during the send
    console.error(`Error in sendEventToHelper`, {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Determines if a given event matches the provided filters.
 * @param event - The Nostr event to check.
 * @param filters - The filters to apply.
 * @returns `true` if the event matches all filters, `false` otherwise.
 */
function matchesFilters(event: NostrEvent, filters: Filters): boolean {
  // Check 'ids' filter
  if (filters.ids && !filters.ids.includes(event.id)) return false;

  // Check 'authors' filter
  if (filters.authors && !filters.authors.includes(event.pubkey)) return false;

  // Check 'kinds' filter
  if (filters.kinds && !filters.kinds.includes(event.kind)) return false;

  // Check 'since' filter (events created after a certain timestamp)
  if (filters.since && event.created_at < filters.since) return false;

  // Check 'until' filter (events created before a certain timestamp)
  if (filters.until && event.created_at > filters.until) return false;

  // Check tag filters (e.g., '#e', '#p')
  for (const [filterKey, filterValues] of Object.entries(filters)) {
    if (filterKey.startsWith("#")) {
      const tagKey = filterKey.slice(1);
      // Extract tag values from the event that match the tag key
      const eventTags = event.tags
        .filter((tag) => tag[0] === tagKey)
        .map((tag) => tag[1]);
      // Check if any of the filter values match the event's tag values
      if (!filterValues.some((value: string) => eventTags.includes(value))) {
        return false;
      }
    }
  }

  // If all filters pass, return true
  return true;
}

/**
 * Splits filters into multiple chunks for distribution to helper workers.
 * @param filters - The filters to split.
 * @param numChunks - The number of chunks to split the filters into.
 * @returns An array of Filters objects representing each chunk.
 */
function splitFilters(filters: Filters, numChunks: number): Filters[] {
  const baseFilters: Filters = {}; // Filters that are not arrays
  const arrayFilters: Record<string, any[]> = {}; // Filters that are arrays

  // Separate base filters and array filters
  for (const key in filters) {
    if (Array.isArray(filters[key])) {
      arrayFilters[key] = filters[key];
    } else {
      baseFilters[key] = filters[key];
    }
  }

  // If there is only one kind or author, do not split the filters
  if (
    arrayFilters.kinds &&
    arrayFilters.kinds.length <= 1 &&
    (!arrayFilters.authors || arrayFilters.authors.length <= 1)
  ) {
    return [filters];
  }

  // Initialize an array of filter chunks with base filters
  const filterChunks: Filters[] = Array(numChunks)
    .fill(null)
    .map(() => ({ ...baseFilters }));
  const arrayKeys = Object.keys(arrayFilters);

  if (arrayKeys.length === 1) {
    // If there's only one array filter key, split its values across chunks
    const key = arrayKeys[0];
    const arrayValues = arrayFilters[key];
    const arrayChunks = splitArray(arrayValues, numChunks);
    for (let i = 0; i < numChunks; i++) {
      filterChunks[i][key] = arrayChunks[i];
    }
  } else {
    // If multiple array filter keys, split each accordingly
    for (const key in arrayFilters) {
      const arrayValues = arrayFilters[key];
      if (key === "authors") {
        // For 'authors', split the array across chunks
        const arrayChunks = splitArray(arrayValues, numChunks);
        for (let i = 0; i < numChunks; i++) {
          filterChunks[i][key] = arrayChunks[i];
        }
      } else {
        // For other array filters, assign all values to each chunk
        for (let i = 0; i < numChunks; i++) {
          filterChunks[i][key] = arrayValues;
        }
      }
    }
  }

  return filterChunks;
}

/**
 * Splits an array into multiple smaller arrays (chunks).
 * @param array - The array to split.
 * @param numChunks - The number of chunks to split the array into.
 * @returns An array of arrays representing the split chunks.
 */
function splitArray<T>(array: T[], numChunks: number): T[][] {
  const chunks: T[][] = Array.from({ length: numChunks }, () => []);
  for (let i = 0; i < array.length; i++) {
    chunks[i % numChunks].push(array[i]);
  }
  return chunks;
}

/**
 * Shuffles an array in place using the Fisher-Yates algorithm.
 * @param array - The array to shuffle.
 * @returns A new array with elements shuffled.
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffledArray = array.slice(); // Create a copy to avoid mutating the original array
  for (let i = shuffledArray.length - 1; i > 0; i--) {
    // Generate a random index
    const j = Math.floor(Math.random() * (i + 1));
    // Swap elements at indices i and j
    [shuffledArray[i], shuffledArray[j]] = [shuffledArray[j], shuffledArray[i]];
  }
  return shuffledArray;
}

/**
 * Validates an array of event IDs to ensure they conform to the expected format.
 * @param ids - The array of event IDs to validate.
 * @throws An error if any of the IDs are invalid.
 */
function validateIds(ids: string[]) {
  for (const id of ids) {
    // Event IDs must be 64-character hexadecimal strings
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error(`Invalid event ID format: ${id}`);
    }
  }
}

/**
 * Validates an array of author public keys to ensure they conform to the expected format.
 * @param authors - The array of author pubkeys to validate.
 * @throws An error if any of the pubkeys are invalid.
 */
function validateAuthors(authors: string[]) {
  for (const author of authors) {
    // Pubkeys must be 64-character hexadecimal strings
    if (!/^[a-f0-9]{64}$/.test(author)) {
      throw new Error(`Invalid author pubkey format: ${author}`);
    }
  }
}

/**
 * Sends an OK message to the client via WebSocket.
 * Indicates the result of processing an EVENT message.
 * @param wsId - The WebSocket ID associated with the connection.
 * @param eventId - The ID of the event being acknowledged.
 * @param status - `true` if the event was processed successfully, `false` otherwise.
 * @param message - A descriptive message regarding the status.
 */
function sendOK(
  wsId: string,
  eventId: string | null,
  status: boolean,
  message: string
) {
  const connection = subscriptions.get(wsId);
  if (connection) {
    // Construct and send the OK message as a JSON string
    connection.ws.send(JSON.stringify(["OK", eventId, status, message]));
  } else {
    console.error(`WebSocket not found for wsId: ${wsId}`);
  }
}

/**
 * Sends an ERROR or NOTICE message to the client via WebSocket.
 * Notifies the client of issues or errors.
 * @param wsId - The WebSocket ID associated with the connection.
 * @param message - The error or notice message to send.
 */
function sendError(wsId: string, message: string) {
  const connection = subscriptions.get(wsId);
  if (connection) {
    // Construct and send the NOTICE message as a JSON string
    connection.ws.send(JSON.stringify(["NOTICE", message]));
  } else {
    console.error(`WebSocket not found for wsId: ${wsId}`);
  }
}

/**
 * Sends an End of Stored Events (EOSE) message to the client via WebSocket.
 * Indicates that no more events are available for the subscription.
 * @param wsId - The WebSocket ID associated with the connection.
 * @param subscriptionId - The subscription ID for which EOSE is sent.
 */
function sendEOSE(wsId: string, subscriptionId: string) {
  const connection = subscriptions.get(wsId);
  if (connection) {
    // Construct and send the EOSE message as a JSON string
    connection.ws.send(JSON.stringify(["EOSE", subscriptionId]));
  } else {
    console.error(`WebSocket not found for wsId: ${wsId}`);
  }
}

/**
 * Verifies the signature of a Nostr event to ensure its authenticity.
 * @param event - The Nostr event whose signature is to be verified.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
async function verifyEventSignature(event: NostrEvent) {
  try {
    // Convert the hexadecimal signature to a byte array
    const signatureBytes = hexToBytes(event.sig);
    // Serialize the event data for signing
    const serializedEventData = serializeEventForSigning(event);
    // Compute the SHA-256 hash of the serialized event data
    const messageHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(serializedEventData)
    );
    const messageHash = new Uint8Array(messageHashBuffer);
    // Convert the hexadecimal pubkey to a byte array
    const publicKeyBytes = hexToBytes(event.pubkey);
    // Verify the signature using the Schnorr algorithm
    const signatureIsValid = schnorr.verify(
      signatureBytes,
      messageHash,
      publicKeyBytes
    );
    return signatureIsValid;
  } catch (error) {
    // Handle any errors during signature verification
    console.error("Error verifying event signature:", error);
    return false;
  }
}

/**
 * Serializes a Nostr event for signing by JSON-stringifying its components.
 * @param event - The Nostr event to serialize.
 * @returns The serialized event string.
 */
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

/**
 * Converts a hexadecimal string to a Uint8Array of bytes.
 * @param hexString - The hexadecimal string to convert.
 * @returns A Uint8Array representing the bytes of the hexadecimal string.
 * @throws An error if the hex string has an invalid format.
 */
function hexToBytes(hexString: string): Uint8Array {
  if (hexString.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexString.substr(i * 2, 2), 16);
  }
  return bytes;
}
