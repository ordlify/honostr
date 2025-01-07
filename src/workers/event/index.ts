import { Hono } from "hono";
import { Context } from "hono";
import { Bindings, Metadata } from "./bindings";
import { initializeD1Database } from "./migration";

// Interface defining the structure of a Nostr event
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// Initialize a new Hono application with custom bindings
const app = new Hono<{ Bindings: Bindings }>();

// Initialize database when the worker starts
app.use("*", async (c, next) => {
  if (c.env.WORKER_ENVIRONMENT === "development") {
    console.log("Initializing database for development...");
    const dbInit = await initializeD1Database(c.env);
    if (!dbInit.success) {
      console.error("Failed to initialize database:", dbInit.error);
    }
  }
  await next();
});

// Update the connection limits
const MAX_R2_WRITES_PER_SECOND = 40;
const MAX_CONCURRENT_CONNECTIONS = 40; // Increased from 6
let activeWriteOperations = 0;

// Separate limiters for reads and writes
async function withWriteLimit<T>(
  promiseFunction: () => Promise<T>
): Promise<T> {
  while (activeWriteOperations >= MAX_R2_WRITES_PER_SECOND) {
    await new Promise((resolve) => setTimeout(resolve, 20)); // Reduced wait time
  }
  activeWriteOperations += 1;
  try {
    return await promiseFunction();
  } finally {
    activeWriteOperations -= 1;
  }
}

// Remove connection limit for reads
async function withReadOperation<T>(
  promiseFunction: () => Promise<T>
): Promise<T> {
  return promiseFunction();
}

// Flag to enable or disable global duplicate hash checks
const enableGlobalDuplicateCheck = false; // Set to true for global duplicate hash regardless of pubkey, or false for per-pubkey hash

// Set containing event kinds that bypass duplicate hash checks
const bypassDuplicateKinds = new Set<number>([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 40, 41, 42, 43, 44,
  64, 818, 1021, 1022, 1040, 1059, 1063, 1311, 1617, 1621, 1622, 1630, 1633,
  1971, 1984, 1985, 1986, 1987, 2003, 2004, 2022, 4550, 5000, 5999, 6000, 6999,
  7000, 9000, 9030, 9041, 9467, 9734, 9735, 9802, 10000, 10001, 10002, 10003,
  10004, 10005, 10006, 10007, 10009, 10015, 10030, 10050, 10063, 10096, 13194,
  21000, 22242, 23194, 23195, 24133, 24242, 27235, 30000, 30001, 30002, 30003,
  30004, 30005, 30007, 30008, 30009, 30015, 30017, 30018, 30019, 30020, 30023,
  30024, 30030, 30040, 30041, 30063, 30078, 30311, 30315, 30402, 30403, 30617,
  30618, 30818, 30819, 31890, 31922, 31923, 31924, 31925, 31989, 31990, 34235,
  34236, 34237, 34550, 39000, 39001, 39002, 39003, 39004, 39005, 39006, 39007,
  39008, 39009,
]);

// Set containing event kinds that are subjected to duplicate hash checks
const duplicateCheckedKinds = new Set<number>();

/**
 * Determines if a given event kind is subject to duplicate hash checks.
 * @param kind - The event kind to check.
 * @returns True if the kind should be checked for duplicates, false otherwise.
 */
function isDuplicateChecked(kind: number): boolean {
  if (duplicateCheckedKinds.size > 0 && !duplicateCheckedKinds.has(kind)) {
    return false;
  }
  return !bypassDuplicateKinds.has(kind);
}

/**
 * Determines if a given event kind bypasses duplicate hash checks.
 * @param kind - The event kind to check.
 * @returns True if the kind bypasses duplicate checks, false otherwise.
 */
function isDuplicateBypassed(kind: number): boolean {
  return bypassDuplicateKinds.has(kind);
}

// Define the POST route to handle incoming Nostr events
app.post("/", async (c: Context<{ Bindings: Bindings }>) => {
  try {
    // Retrieve the Authorization header from the request
    const authHeader = c.req.header("Authorization");

    const cacheEvent = c.req.header("Cache-Event") ? true : false;
    console.log(`Cache-Event header received: ${cacheEvent}`);

    // Validate the Authorization header against the expected AUTH_TOKEN
    if (!authHeader || authHeader !== `Bearer ${c.env.AUTH_TOKEN}`) {
      console.warn("Unauthorized request.");
      return c.text("Unauthorized", 401);
    }

    // Parse the JSON body of the request to extract the message type and event
    const { type, event } = await c.req.json();
    console.log(`Request type: ${type}, Event ID: ${event.id}`);

    // Handle different types of messages; currently only "EVENT" is supported
    if (type === "EVENT") {
      console.log(`Processing event with ID: ${event.id}`);
      const result = await processEvent(event, cacheEvent, c.env);
      if (result.success) {
        return c.text("Event received successfully", 200);
      } else {
        return c.text(result.error || "Error processing event", 500);
      }
    } else {
      console.warn(`Invalid request type: ${type}`);
      return c.text("Invalid request type", 400);
    }
  } catch (error) {
    console.error("Error processing POST request:", error);
    return c.text(`Error processing request: ${(error as Error).message}`, 500);
  }
});

/**
 * Processes an incoming Nostr event.
 * @param event - The Nostr event to process.
 * @param c - The Hono context containing bindings.
 * @returns An object indicating success or failure, with an optional error message.
 */
async function processEvent(
  event: NostrEvent,
  cacheEvent: boolean,
  c: Bindings
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if the event is a deletion event (kind 5)
    if (event.kind === 5) {
      console.log(`Processing deletion event for event ID: ${event.id}`);
      await processDeletionEvent(event, c);
      return { success: true };
    }

    console.log(`Saving event with ID: ${event.id} to R2...`);
    // Attempt to save the event to the R2 bucket
    const saveResult = await saveEventToR2(event, cacheEvent, c);

    if (!saveResult.success) {
      console.error(
        `Failed to save event with ID: ${event.id}`,
        saveResult.error
      );
      return { success: false, error: saveResult.error };
    }

    // if cacheEvent is true, send the event to the relay worker
    const d1Result = await saveEventToD1(event, cacheEvent, c);
    if (!d1Result.success) {
      console.error(`Failed to save event with ID: ${event.id} to D1`);
      return { success: false, error: d1Result.error };
    }

    console.log(`Event with ID: ${event.id} processed successfully.`);
    return { success: true };
  } catch (error) {
    console.error("Error in EVENT processing:", error);
    return {
      success: false,
      error: `Error: EVENT processing failed - ${(error as Error).message}`,
    };
  }
}

/**
 * Saves a Nostr event to the R2 bucket, handling duplicate checks and indexing.
 * @param event - The Nostr event to save.
 * @param c - The Hono context containing bindings.
 * @returns An object indicating success or failure, with an optional error message.
 */
async function saveEventToR2(
  event: NostrEvent,
  cacheEvent: boolean,
  c: Bindings
): Promise<{ success: boolean; error?: string }> {
  const eventKey = `events/event:${event.id}`;

  try {
    // Handle expiration
    let r2Options: R2PutOptions = {};
    const expirationTag = event.tags.find((tag) => tag[0] === "expiration");

    if (expirationTag?.[1]) {
      // Simplified check
      const expirationTimestamp = parseInt(expirationTag[1], 10);
      if (!isNaN(expirationTimestamp)) {
        r2Options.httpMetadata = {
          cacheExpiry: new Date(expirationTimestamp * 1000),
        };
      }
    }

    r2Options.customMetadata = {
      id: event.id,
      kindKey: `kinds/kind_${event.kind}`,
      pubkeyKey: `pubkeys/pubkey_${event.pubkey}`,
      contentHashKey: "",
    };

    // Only check for duplicates if not a cache event
    if (!cacheEvent) {
      // Fast check for existing event using head
      const existingEvent = await withReadOperation(() =>
        c.relayDb.head(eventKey)
      ).catch(() => null);

      if (existingEvent) {
        return { success: false, error: "Duplicate event" };
      }

      // Content hash check only if needed
      if (!isDuplicateBypassed(event.kind)) {
        const contentHash = await hashContent(event);
        const contentHashKey = enableGlobalDuplicateCheck
          ? `hashes/${contentHash}`
          : `hashes/${event.pubkey}:${contentHash}`;

        const existingHash = await withReadOperation(() =>
          c.relayDb.head(contentHashKey)
        ).catch(() => null);

        if (existingHash) {
          return { success: false, error: "Duplicate content detected" };
        }

        r2Options.customMetadata = {
          ...r2Options.customMetadata,
          contentHashKey,
        };

        // Save content hash if needed
        await withWriteLimit(() =>
          c.relayDb.put(contentHashKey, JSON.stringify(event), r2Options)
        );
      }
    }

    // Save event with metadata
    await withWriteLimit(() =>
      c.relayDb.put(eventKey, JSON.stringify(event), r2Options)
    );

    // Handle first event caching if needed
    if (cacheEvent) {
      queueMicrotask(async () => {
        try {
          const pubkeyCountKey = `pubkey_count_${event.pubkey}`;
          const pubkeyCount = await getCount(pubkeyCountKey, c);
          if (pubkeyCount + 1 === 1) {
            await saveToKV(`cached/pubkey_${event.pubkey}`, event.id, c);
          }
        } catch (error) {
          console.error("First event caching error:", error);
        }
      });
    }

    return { success: true };
  } catch (error) {
    console.error(`R2 error: ${(error as Error).message}`);
    return {
      success: false,
      error: `Error saving event data: ${(error as Error).message}`,
    };
  }
}

async function saveToKV(key: string, value: string, c: Bindings) {
  await c.honostrKV.put(key, value);
}

async function saveEventToD1(
  event: NostrEvent,
  cacheEvent: boolean,
  c: Bindings
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log(`Saving event with ID: ${event.id} to D1...`);

    // Handle expiration
    let expires_at: number | null = null;
    const expirationTag = event.tags.find((tag) => tag[0] === "expiration");
    if (expirationTag && expirationTag[1]) {
      const expirationTimestamp = parseInt(expirationTag[1], 10);
      if (!isNaN(expirationTimestamp)) {
        expires_at = expirationTimestamp;
      }
    }

    // Insert the event
    const insertEventStmt = c.DB.prepare(`
      INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING;
    `);

    const insertMetadataStmt = c.DB.prepare(`
      INSERT INTO metadata (event_id, pubkey, created_at, kind, tags, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING;
    `);

    const eventKindCountStmt = c.DB.prepare(`
      INSERT INTO counts (key, count) VALUES (?, 1)
      ON CONFLICT(key) DO UPDATE SET count = count + 1
    `);

    const eventPubkeyCountStmt = c.DB.prepare(`
      INSERT INTO counts (key, count) VALUES (?, 1)
      ON CONFLICT(key) DO UPDATE SET count = count + 1
    `);

    const executeResult = await c.DB.batch([
      insertEventStmt.bind(
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        event.content,
        event.sig,
        expires_at
      ),
      insertMetadataStmt.bind(
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        expires_at
      ),
      eventKindCountStmt.bind(`kind_count_${event.kind}`),
      eventPubkeyCountStmt.bind(`pubkey_count_${event.pubkey}`),
    ]);

    if (executeResult) {
      console.log(`Event with ID: ${event.id} saved to D1 successfully.`);
      return { success: true };
    }

    return { success: false, error: "Failed to save event to D1" };
  } catch (error) {
    console.error(`Error saving event to D1: ${(error as Error).message}`);
    return {
      success: false,
      error: `Error saving to D1: ${(error as Error).message}`,
    };
  }
}

async function getCount(key: string, c: Bindings): Promise<number> {
  try {
    const stmt = c.DB.prepare(`SELECT count FROM counts WHERE key = ?`);
    const result: { key: string; count: number } | null = await stmt
      .bind(key)
      .first();
    return result ? result.count : 0;
  } catch (error) {
    console.error(
      `Error retrieving count for key ${key}: ${(error as Error).message}`
    );
    throw new Error(
      `Error retrieving count for key ${key}: ${(error as Error).message}`
    );
  }
}

/**
 * Handles deletion events (kind 5) by removing the specified events from R2.
 * @param deletionEvent - The deletion event containing tags with event IDs to delete.
 * @param c - The Hono context containing bindings.
 */
async function processDeletionEvent(deletionEvent: NostrEvent, c: Bindings) {
  console.log(`Processing deletion event: ${deletionEvent.id}`);
  const deletedEventIds = deletionEvent.tags
    .filter((tag) => tag[0] === "e")
    .map((tag) => tag[1]);

  for (const eventId of deletedEventIds) {
    const eventKey = `events/event:${eventId}`;
    try {
      console.log(`Attempting to delete event with ID: ${eventId}`);
      // Use read operation for getting metadata
      const eventObject = await withReadOperation(() =>
        c.relayDb.head(eventKey)
      );

      const customMetadata: Record<string, string> | undefined =
        eventObject?.customMetadata;

      if (customMetadata) {
        const contentHashKey = customMetadata.contentHashKey
          ? customMetadata.contentHashKey
          : undefined;

        const keysToDelete = [eventKey];

        if (contentHashKey) {
          keysToDelete.push(contentHashKey);
        }

        // Delete R2 objects in parallel with write limits
        await Promise.all(
          keysToDelete.map((key) => withWriteLimit(() => c.relayDb.delete(key)))
        );

        // Delete from D1 in parallel
        await Promise.all([
          c.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(eventId).run(),
          c.DB.prepare(`DELETE FROM metadata WHERE event_id = ?`)
            .bind(eventId)
            .run(),
        ]);

        // Purge cache without waiting
        purgeCloudflareCache(keysToDelete, c).catch((error) =>
          console.error("Cache purge error:", error)
        );

        console.log(`Deleted event: ${eventId}`);
      } else {
        console.warn(`Event with ID: ${eventId} not found. Nothing to delete.`);
      }
    } catch (error) {
      console.error(`Deletion error ${eventId}: ${(error as Error).message}`);
    }
  }
}

/**
 * Purges specified URLs from the Cloudflare cache to ensure deleted events are not served.
 * @param keys - The R2 keys corresponding to the events to purge.
 * @param c - The Hono context containing bindings.
 */
async function purgeCloudflareCache(keys: string[], c: Bindings) {
  const headers = new Headers();
  headers.append("Authorization", `Bearer ${c.API_TOKEN}`);
  headers.append("Content-Type", "application/json");

  const urls = keys.map((key) => `https://${c.R2_BUCKET_DOMAIN}/${key}`);

  const requestOptions = {
    method: "POST",
    headers: headers,
    body: JSON.stringify({ files: urls }),
  };

  // No need for connection limit here as it's an external API call
  console.log(`Purging Cloudflare cache for URLs: ${urls}`);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${c.ZONE_ID}/purge_cache`,
    requestOptions
  );

  if (!response.ok) {
    throw new Error(`Failed to purge Cloudflare cache: ${response.status}`);
  }

  response.body?.cancel(); // Cancel the response body to free up resources
  console.log(`Cache purged for ${keys.length} keys`);
}

/**
 * Generates a SHA-256 hash of the event content to detect duplicates.
 * @param event - The Nostr event to hash.
 * @returns The hexadecimal representation of the hash.
 */
async function hashContent(event: NostrEvent): Promise<string> {
  // Define the content to hash based on the duplicate check configuration
  const contentToHash = enableGlobalDuplicateCheck
    ? JSON.stringify({
        kind: event.kind,
        tags: event.tags,
        content: event.content,
      })
    : JSON.stringify({
        pubkey: event.pubkey,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
      });

  // Encode the content and compute the SHA-256 hash
  const buffer = new TextEncoder().encode(contentToHash);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hash = bytesToHex(new Uint8Array(hashBuffer));
  return hash;
}

/**
 * Converts a byte array to a hexadecimal string.
 * @param bytes - The byte array to convert.
 * @returns The resulting hexadecimal string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
// Export the Hono application as the default export
export default app;
