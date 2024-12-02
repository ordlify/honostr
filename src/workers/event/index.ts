import { Hono } from "hono";
import { Context } from "hono";
import { Bindings, Metadata } from "./bindings";

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

const app = new Hono<{ Bindings: Bindings }>();

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

// Setting to enable or disable global duplicate hash check
const enableGlobalDuplicateCheck = false; // Set to true for global duplicate hash regardless of pubkey, or false for per-pubkey hash

// Bypass kinds from duplicate hash checks - all kinds bypassed by default
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

// Kinds subjected to duplicate hash checks
const duplicateCheckedKinds = new Set<number>();

function isDuplicateChecked(kind: number): boolean {
  if (duplicateCheckedKinds.size > 0 && !duplicateCheckedKinds.has(kind)) {
    return false;
  }
  return !bypassDuplicateKinds.has(kind);
}

function isDuplicateBypassed(kind: number): boolean {
  return bypassDuplicateKinds.has(kind);
}

app.post("/", async (c: Context<{ Bindings: Bindings }>) => {
  try {
    // Checks if Authorization header is present and matches AUTH_TOKEN
    const authHeader = c.req.header("Authorization");
    console.log(`Authorization header received: ${authHeader !== null}`);

    if (!authHeader || authHeader !== `Bearer ${c.env.AUTH_TOKEN}`) {
      console.warn("Unauthorized request.");
      return c.text("Unauthorized", 401);
    }

    const { type, event } = await c.req.json();
    console.log(`Request type: ${type}, Event ID: ${event.id}`);

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

// Handles EVENT message
async function processEvent(
  event: NostrEvent,
  c: Context<{ Bindings: Bindings }>
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if deletion event (kind 5)
    if (event.kind === 5) {
      console.log(`Processing deletion event for event ID: ${event.id}`);
      await processDeletionEvent(event, c);
      return { success: true };
    }

    console.log(`Saving event with ID: ${event.id} to R2...`);
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

// Handles saving event to R2 bucket
async function saveEventToR2(
  event: NostrEvent,
  c: Context<{ Bindings: Bindings }>
): Promise<{ success: boolean; error?: string }> {
  const eventKey = `events/event:${event.id}`;
  const metadataKey = `metadata/event:${event.id}`;
  console.log(`Generating content hash for event with ID: ${event.id}`);

  const contentHash = await hashContent(event);
  const contentHashKey = enableGlobalDuplicateCheck
    ? `hashes/${contentHash}`
    : `hashes/${event.pubkey}:${contentHash}`;

  // Check if the event kind allows duplicate hash checks
  if (isDuplicateBypassed(event.kind)) {
    console.log(`Skipping duplicate check for kind: ${event.kind}`);
  } else {
    // Check if the content hash already exists
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
    }
  }

  // Check if the event ID already exists
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
  }

  // Fetch current counts for kind and pubkey
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

  const kindKey = `kinds/kind-${event.kind}:${kindCount + 1}`;
  const pubkeyKey = `pubkeys/pubkey-${event.pubkey}:${pubkeyCount + 1}`;

  // Create metadata object to track related keys
  const metadata = {
    kindKey,
    pubkeyKey,
    tags: [] as string[],
    contentHashKey,
  };

  const eventWithCountRef = { ...event, kindKey, pubkeyKey };

  // Handle tags in batches
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

        if (currentBatch.length === 5) {
          tagBatches.push(Promise.all(currentBatch).then(() => {}));
          currentBatch = [];
        }
      }
    }

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
    // Save event and related data sequentially with connection limiting
    console.log(`Saving event and related data for event ID: ${event.id}`);
    await Promise.all([
      withConnectionLimit(() =>
        c.env.relayDb.put(kindKey, JSON.stringify(event))
      ),
      withConnectionLimit(() =>
        c.env.relayDb.put(pubkeyKey, JSON.stringify(event))
      ),
      withConnectionLimit(() =>
        c.env.relayDb.put(eventKey, JSON.stringify(eventWithCountRef))
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
        c.env.relayDb.put(metadataKey, JSON.stringify(metadata))
      ),
    ]);

    // Batch save tag data
    for (const batch of tagBatches) {
      await batch;
    }

    // Save the content hash if duplicate checks are enabled for this kind
    if (!isDuplicateBypassed(event.kind)) {
      console.log(`Saving content hash for event ID: ${event.id}`);
      await withConnectionLimit(() =>
        c.env.relayDb.put(contentHashKey, JSON.stringify(event))
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

// Retrieves count from R2, returns 0 if not found
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

// Handles event deletion
async function processDeletionEvent(
  deletionEvent: NostrEvent,
  c: Context<{ Bindings: Bindings }>
) {
  console.log(`Processing deletion event with ID: ${deletionEvent.id}`);
  const deletedEventIds = deletionEvent.tags
    .filter((tag) => tag[0] === "e")
    .map((tag) => tag[1]);

  for (const eventId of deletedEventIds) {
    const metadataKey = `metadata/event:${eventId}`;
    try {
      console.log(`Attempting to delete event with ID: ${eventId}`);
      // Get the metadata associated with the event
      const metadataResponse = await withConnectionLimit(() =>
        c.env.relayDb.get(metadataKey)
      );

      if (metadataResponse) {
        const metadata: Metadata = await metadataResponse.json();

        // Collect all keys to delete
        const keysToDelete = [
          `events/event:${eventId}`, // Event content
          metadata.kindKey, // Kind reference
          metadata.pubkeyKey, // Pubkey reference
          metadata.contentHashKey, // Content hash reference
          ...metadata.tags, // Associated tags
        ];

        // Delete all related keys simultaneously
        await Promise.all(
          keysToDelete.map((key) =>
            withConnectionLimit(() => c.env.relayDb.delete(key))
          )
        );

        // Also delete the metadata key itself
        await withConnectionLimit(() => c.env.relayDb.delete(metadataKey));

        // Purge from cache
        await purgeCloudflareCache(keysToDelete, c);

        console.log(`Event ${eventId} and its metadata deleted successfully.`);
      } else {
        // Log message if event is not found
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

// Purges Cloudflare cache
async function purgeCloudflareCache(
  keys: string[],
  c: Context<{ Bindings: Bindings }>
) {
  const headers = new Headers();
  headers.append("Authorization", `Bearer ${c.env.API_TOKEN}`);
  headers.append("Content-Type", "application/json");

  // Construct URLs without encoding `/` and `:`
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
      response.body?.cancel();
    } else {
      throw new Error(`Failed to purge Cloudflare cache: ${response.status}`);
    }
    console.log(`Cloudflare cache purged for URLs:`, urls);
  });
}

// Hash content (excluding the ID)
async function hashContent(event: NostrEvent): Promise<string> {
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

  const buffer = new TextEncoder().encode(contentToHash);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hash = bytesToHex(new Uint8Array(hashBuffer));
  console.log(`Generated hash for event ID: ${event.id}: ${hash}`);
  return hash;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export default app;
