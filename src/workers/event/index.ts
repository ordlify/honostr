import { Hono } from "hono";
import { Context } from "hono";
import { Bindings, Metadata } from "./bindings";

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

// Maximum number of concurrent connections allowed
const MAX_CONCURRENT_CONNECTIONS = 6;
let activeConnections = 0;

/**
 * Controls the number of active connections to prevent overloading.
 * Implements a semaphore-like mechanism to limit concurrency.
 * @param promiseFunction - The asynchronous function to execute.
 * @returns The resolved value of the provided promiseFunction.
 */
async function withConnectionLimit<T>(
  promiseFunction: () => Promise<T>
): Promise<T> {
  // Wait if the number of active connections has reached the maximum limit
  while (activeConnections >= MAX_CONCURRENT_CONNECTIONS) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Increment the count of active connections
  activeConnections += 1;
  try {
    // Execute the provided asynchronous function
    return await promiseFunction();
  } finally {
    // Decrement the count after the function has completed
    activeConnections -= 1;
  }
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
    console.log(`Authorization header received: ${authHeader !== null}`);

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
      const result = await processEvent(event, c);
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
  c: Context<{ Bindings: Bindings }>
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
    const saveResult = await saveEventToR2(event, c);

    if (!saveResult.success) {
      console.error(`Failed to save event with ID: ${event.id}`);
      return { success: false, error: saveResult.error };
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
  c: Context<{ Bindings: Bindings }>
): Promise<{ success: boolean; error?: string }> {
  // Add expiration handling near the start of the function
  let customMetadata = {};
  const expirationTag = event.tags.find((tag) => tag[0] === "expiration");

  if (expirationTag && expirationTag[1]) {
    const expirationTimestamp = parseInt(expirationTag[1], 10);
    if (!isNaN(expirationTimestamp)) {
      // Convert UNIX timestamp to HTTP date format for R2
      const expirationDate = new Date(expirationTimestamp * 1000);
      customMetadata = {
        httpMetadata: {
          expires: expirationDate.toUTCString(),
        },
      };
    }
  }

  // Define keys for storing the event and its metadata in R2
  const eventKey = `events/event:${event.id}`;
  const metadataKey = `metadata/event:${event.id}`;
  console.log(`Generating content hash for event with ID: ${event.id}`);

  // Generate a hash of the event content to detect duplicates
  const contentHash = await hashContent(event);
  const contentHashKey = enableGlobalDuplicateCheck
    ? `hashes/${contentHash}`
    : `hashes/${event.pubkey}:${contentHash}`;

  // Determine if the event kind should bypass duplicate hash checks
  if (isDuplicateBypassed(event.kind)) {
    console.log(`Skipping duplicate check for kind: ${event.kind}`);
  } else {
    // Attempt to retrieve an existing hash to detect duplicates
    try {
      console.log(
        `Checking for existing content hash for event ID: ${event.id}`
      );
      const existingHash = await withConnectionLimit(() =>
        c.env.relayDb.get(contentHashKey)
      );
      if (existingHash) {
        console.log(
          `Duplicate content detected for event: ${JSON.stringify(
            event
          )}. Event dropped.`
        );
        return {
          success: false,
          error: `Duplicate content detected for event with content: ${event.content}`,
        };
      }
    } catch (error) {
      // If the error is not due to the hash not existing, log it
      if (
        (error as any).name !== "R2Error" ||
        (error as any).message !== "R2 object not found"
      ) {
        console.error(
          `Error checking content hash in R2: ${(error as Error).message}`
        );
        return {
          success: false,
          error: `Error checking content hash in R2: ${
            (error as Error).message
          }`,
        };
      }
      // If the hash does not exist, proceed to save the event
    }
  }

  // Check if the event ID already exists to prevent duplicates
  try {
    console.log(`Checking for existing event ID: ${event.id}`);
    const existingEvent = await withConnectionLimit(() =>
      c.env.relayDb.get(eventKey)
    );
    if (existingEvent) {
      console.log(`Duplicate event: ${event.id}. Event dropped.`);
      return { success: false, error: "Duplicate event" };
    }
  } catch (error) {
    // If the error is not due to the event not existing, log it
    if (
      (error as any).name !== "R2Error" ||
      (error as any).message !== "R2 object not found"
    ) {
      console.error(
        `Error checking duplicate event in R2: ${(error as Error).message}`
      );
      return {
        success: false,
        error: `Error checking duplicate event in R2: ${
          (error as Error).message
        }`,
      };
    }
    // If the event does not exist, proceed to save it
  }

  // Fetch current counts for the event's kind and pubkey to index the event
  let kindCount: number, pubkeyCount: number;
  try {
    const kindCountKey = `counts/kind_count_${event.kind}`;
    const pubkeyCountKey = `counts/pubkey_count_${event.pubkey}`;
    console.log(
      `Fetching counts for kind: ${event.kind} and pubkey: ${event.pubkey}`
    );

    kindCount = await getCount(kindCountKey, c);
    pubkeyCount = await getCount(pubkeyCountKey, c);
  } catch (error) {
    console.error(
      `Error fetching counts for kind or pubkey: ${(error as Error).message}`
    );
    return {
      success: false,
      error: `Error fetching counts: ${(error as Error).message}`,
    };
  }

  // Define keys for indexing the event by kind and pubkey
  const kindKey = `kinds/kind-${event.kind}:${kindCount + 1}`;
  const pubkeyKey = `pubkeys/pubkey-${event.pubkey}:${pubkeyCount + 1}`;

  // Create a metadata object to track related keys
  const metadata = {
    kindKey,
    pubkeyKey,
    tags: [] as string[],
    contentHashKey,
  };

  // Reference the event with count-based keys
  const eventWithCountRef = { ...event, kindKey, pubkeyKey };

  // Handle tags in batches to optimize storage operations
  const tagBatches: Promise<void>[] = [];
  let currentBatch: Promise<void>[] = [];

  try {
    console.log(`Processing and saving tags for event ID: ${event.id}`);
    for (const tag of event.tags) {
      const [tagName, tagValue] = tag;
      if (tagName && tagValue) {
        const tagKey = `tags/${tagName}-${tagValue}:${kindCount + 1}`;
        metadata.tags.push(tagKey);
        currentBatch.push(
          withConnectionLimit(async () => {
            await c.env.relayDb.put(tagKey, JSON.stringify(event));
          })
        );

        // If the current batch reaches 5 tags, add it to the tagBatches array
        if (currentBatch.length === 5) {
          tagBatches.push(Promise.all(currentBatch).then(() => {}));
          currentBatch = [];
        }
      }
    }

    // Add any remaining tags in the current batch to tagBatches
    if (currentBatch.length > 0) {
      tagBatches.push(Promise.all(currentBatch).then(() => {}));
    }
  } catch (error) {
    console.error(
      `Error processing tags for event ID: ${event.id}: ${
        (error as Error).message
      }`
    );
    return {
      success: false,
      error: `Error processing tags: ${(error as Error).message}`,
    };
  }

  try {
    console.log(`Saving event and related data for event ID: ${event.id}`);
    // Save the event and its related data (kind, pubkey, counts, metadata) to R2
    await Promise.all([
      withConnectionLimit(() =>
        c.env.relayDb.put(kindKey, JSON.stringify(event), { customMetadata })
      ),
      withConnectionLimit(() =>
        c.env.relayDb.put(pubkeyKey, JSON.stringify(event), { customMetadata })
      ),
      withConnectionLimit(() =>
        c.env.relayDb.put(eventKey, JSON.stringify(eventWithCountRef), {
          customMetadata,
        })
      ),
      withConnectionLimit(() =>
        c.env.relayDb.put(
          `counts/kind_count_${event.kind}`,
          (kindCount + 1).toString()
        )
      ),
      withConnectionLimit(() =>
        c.env.relayDb.put(
          `counts/pubkey_count_${event.pubkey}`,
          (pubkeyCount + 1).toString()
        )
      ),
      withConnectionLimit(() =>
        c.env.relayDb.put(metadataKey, JSON.stringify(metadata), {
          customMetadata,
        })
      ),
    ]);

    // Execute all tag batches to save tag data
    for (const batch of tagBatches) {
      await batch;
    }

    // Save the content hash to R2 if duplicate checks are enabled for this kind
    if (!isDuplicateBypassed(event.kind)) {
      console.log(`Saving content hash for event ID: ${event.id}`);
      await withConnectionLimit(() =>
        c.env.relayDb.put(contentHashKey, JSON.stringify(event), {
          customMetadata,
        })
      );
    }

    console.log(`Event ${event.id} saved successfully.`);
    return { success: true };
  } catch (error) {
    console.error(
      `Error saving event data in R2 for event ID: ${event.id}: ${
        (error as Error).message
      }`
    );
    return {
      success: false,
      error: `Error saving event data: ${(error as Error).message}`,
    };
  }
}

/**
 * Retrieves the current count for a given key from R2.
 * If the key does not exist, returns 0.
 * @param key - The R2 key to retrieve the count from.
 * @param c - The Hono context containing bindings.
 * @returns The current count as a number.
 */
async function getCount(
  key: string,
  c: Context<{ Bindings: Bindings }>
): Promise<number> {
  try {
    console.log(`Retrieving count for key: ${key}`);
    const response = await withConnectionLimit(() => c.env.relayDb.get(key));
    const value = response ? await response.text() : "0";
    const count = parseInt(value, 10);
    return isNaN(count) ? 0 : count;
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
async function processDeletionEvent(
  deletionEvent: NostrEvent,
  c: Context<{ Bindings: Bindings }>
) {
  console.log(`Processing deletion event with ID: ${deletionEvent.id}`);
  // Extract event IDs to delete from the deletion event's tags
  const deletedEventIds = deletionEvent.tags
    .filter((tag) => tag[0] === "e")
    .map((tag) => tag[1]);

  // Iterate over each event ID to perform deletion
  for (const eventId of deletedEventIds) {
    const metadataKey = `metadata/event:${eventId}`;
    try {
      console.log(`Attempting to delete event with ID: ${eventId}`);
      // Retrieve the metadata associated with the event
      const metadataResponse = await withConnectionLimit(() =>
        c.env.relayDb.get(metadataKey)
      );

      if (metadataResponse) {
        const metadata: Metadata = await metadataResponse.json();

        // Compile all related keys that need to be deleted
        const keysToDelete = [
          `events/event:${eventId}`, // Event content
          metadata.kindKey, // Kind reference
          metadata.pubkeyKey, // Pubkey reference
          metadata.contentHashKey, // Content hash reference
          ...metadata.tags, // Associated tags
        ];

        // Delete all related keys concurrently
        await Promise.all(
          keysToDelete.map((key) =>
            withConnectionLimit(() => c.env.relayDb.delete(key))
          )
        );

        // Also delete the metadata key itself
        await withConnectionLimit(() => c.env.relayDb.delete(metadataKey));

        // Purge the deleted keys from the Cloudflare cache
        await purgeCloudflareCache(keysToDelete, c);

        console.log(`Event ${eventId} and its metadata deleted successfully.`);
      } else {
        // Log a warning if the event is not found
        console.warn(`Event with ID: ${eventId} not found. Nothing to delete.`);
      }
    } catch (error) {
      console.error(
        `Error processing deletion for event ${eventId}: ${
          (error as Error).message
        }`
      );
    }
  }
}

/**
 * Purges specified URLs from the Cloudflare cache to ensure deleted events are not served.
 * @param keys - The R2 keys corresponding to the events to purge.
 * @param c - The Hono context containing bindings.
 */
async function purgeCloudflareCache(
  keys: string[],
  c: Context<{ Bindings: Bindings }>
) {
  const headers = new Headers();
  headers.append("Authorization", `Bearer ${c.env.API_TOKEN}`);
  headers.append("Content-Type", "application/json");

  // Construct full URLs for the keys without encoding `/` and `:`
  const urls = keys.map((key) => `https://${c.env.R2_BUCKET_DOMAIN}/${key}`);

  const requestOptions = {
    method: "POST",
    headers: headers,
    body: JSON.stringify({ files: urls }),
  };

  return withConnectionLimit(async () => {
    console.log(`Purging Cloudflare cache for URLs: ${urls}`);
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${c.env.ZONE_ID}/purge_cache`,
      requestOptions
    );
    if (response.ok) {
      response.body?.cancel(); // Cancel the response body to free up resources
    } else {
      throw new Error(`Failed to purge Cloudflare cache: ${response.status}`);
    }
    console.log(`Cloudflare cache purged for URLs:`, urls);
  });
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
  console.log(`Generated hash for event ID: ${event.id}: ${hash}`);
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
