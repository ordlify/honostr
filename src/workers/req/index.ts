import { Hono } from "hono";
import { Context } from "hono";
import { Bindings } from "./bindings";

/**
 * Interface defining the structure of a Nostr event.
 */
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Interface defining the structure of filters used in REQ messages.
 */
interface Filters {
  ids?: string[]; // Array of event IDs to filter
  kinds?: number[]; // Array of event kinds to filter
  authors?: string[]; // Array of author public keys to filter
  since?: number; // Unix timestamp to filter events created after this time
  until?: number; // Unix timestamp to filter events created before this time
  limit?: number; // Maximum number of events to return
  tags?: [string, string][]; // Array of tag filters, each as a tuple [tagName, tagValue]
  [key: string]: any; // Allows for additional dynamic filters
}

/**
 * Parses a D1 database row into a NostrEvent object.
 * @param row - The database row containing event data.
 * @returns A NostrEvent object or null if parsing fails.
 */
function parseD1RowToEvent(row: any): NostrEvent | null {
  try {
    return {
      id: row.id,
      pubkey: row.pubkey,
      created_at: row.created_at,
      kind: row.kind,
      tags: JSON.parse(row.tags as string),
      content: row.content,
      sig: row.sig,
    } as NostrEvent;
  } catch (error) {
    console.error(`Error parsing event from D1:`, error);
    return null;
  }
}

/**
 * Converts D1 query results into NostrEvents.
 * @param results - The D1 query results.
 * @param r2BucketDomain - The R2 bucket domain for fallback fetching.
 * @returns Array of promises resolving to NostrEvent objects.
 */
function parseD1ResultsToEvents(
  results: any[],
  r2BucketDomain: string
): Promise<NostrEvent | null>[] {
  return results.map((row) => {
    const event = parseD1RowToEvent(row);
    if (event === null) {
      // Fallback to R2 if parsing fails
      return fetchEventById(row.id, r2BucketDomain);
    }
    return Promise.resolve(event);
  });
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

/**
 * Defines the POST route to handle incoming REQ messages.
 * This route processes client subscriptions by fetching relevant events based on provided filters.
 */
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

    // Parse the JSON body of the request to extract the message type, subscription ID, and filters
    const { type, subscriptionId, filters } = await c.req.json();

    console.log(`Request type: ${type}, Subscription ID: ${subscriptionId}`);

    // Handle different types of messages; currently only "REQ" is supported
    if (type === "REQ") {
      console.log(`Processing REQ with filters: ${JSON.stringify(filters)}`);
      // Process the REQ message by fetching relevant events based on the filters
      const events = await processReq(subscriptionId, filters, c);
      console.log(
        `Returning ${events.length} events for subscription ID: ${subscriptionId}`
      );
      // Respond with the fetched events in JSON format
      return c.json(events);
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
 * Processes a REQ message by fetching events based on provided filters.
 * @param subscriptionId - The unique identifier for the subscription.
 * @param filters - The filters to apply when fetching events.
 * @param c - The Hono context containing bindings.
 * @returns An array of NostrEvent objects that match the filters.
 */
async function processReq(
  subscriptionId: string,
  filters: Filters,
  c: Context<{ Bindings: Bindings }>
): Promise<NostrEvent[]> {
  console.log(`Processing request for subscription ID: ${subscriptionId}`);

  let events: NostrEvent[] = [];
  const eventPromises: Promise<NostrEvent | null>[] = [];

  // Attempt to fetch events based on different types of filters
  try {
    if (filters.ids) {
      console.log(`Fetching events by IDs: ${filters.ids}`);
      // Fetch events by their unique IDs in batches
      eventPromises.push(
        ...fetchEventsById(filters.ids, c.env.R2_BUCKET_DOMAIN)
      );
    }
    if (filters.kinds) {
      console.log(`Fetching events by kinds: ${filters.kinds}`);
      // Fetch events by their kind/category
      eventPromises.push(...(await fetchEventsByKind(filters.kinds, c)));
    }
    if (filters.authors) {
      console.log(`Fetching events by authors: ${filters.authors}`);
      // Fetch events by their authors' public keys
      eventPromises.push(...(await fetchEventsByAuthor(filters.authors, c)));
    }
    if (filters.tags) {
      console.log(`Fetching events by tags: ${JSON.stringify(filters.tags)}`);
      // Fetch events by specific tags
      eventPromises.push(...(await fetchEventsByTag(filters.tags, c)));
    }

    // Await all fetched events
    const fetchedEvents = await Promise.all(eventPromises);
    console.log(`Fetched ${fetchedEvents.length} events, applying filters...`);
    // Filter the fetched events based on additional criteria
    events = filterEvents(
      fetchedEvents.filter((event): event is NostrEvent => event !== null),
      filters
    );
  } catch (error) {
    console.error(`Error retrieving events from R2:`, error);
  }

  console.log(`Returning ${events.length} filtered events.`);
  return events;
}

/**
 * Fetches events by their unique IDs in batches to optimize performance.
 * @param ids - An array of event IDs to fetch.
 * @param r2BucketDomain - The domain of the R2 bucket where events are stored.
 * @param batchSize - The number of IDs to process in each batch.
 * @returns An array of promises resolving to NostrEvent objects or null if not found.
 */
function fetchEventsById(
  ids: string[],
  r2BucketDomain: string,
  batchSize = 10
): Promise<NostrEvent | null>[] {
  console.log(`Fetching events by IDs in batches of ${batchSize}`);
  const batches: Promise<NostrEvent | null>[] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    console.log(`Processing batch: ${batch}`);
    // Fetch each event by its ID and add the promise to the batches array
    batches.push(...batch.map((id) => fetchEventById(id, r2BucketDomain)));
  }
  return batches;
}

/**
 * Fetches a single event by its unique ID from the R2 bucket.
 * @param id - The unique identifier of the event.
 * @param r2BucketDomain - The domain of the R2 bucket where events are stored.
 * @returns A promise resolving to a NostrEvent object or null if not found.
 */
async function fetchEventById(
  id: string,
  r2BucketDomain: string
): Promise<NostrEvent | null> {
  const idKey = `events/event:${id}`;
  const eventUrl = `https://${r2BucketDomain}/${idKey}`;

  console.log(`Attempting to fetch from: ${eventUrl}`); // Debug URL

  try {
    return withConnectionLimit(async () => {
      const response = await fetch(eventUrl);
      if (!response.ok) {
        console.warn(
          `Event not found for ID: ${id} (${response.status}) at ${eventUrl}`
        );
        return null;
      }
      const data = await response.text();

      try {
        return JSON.parse(data) as NostrEvent;
      } catch (parseError) {
        console.error(`Error parsing event ${id}:`, parseError);
        console.error("Raw data:", data);
        return null;
      }
    });
  } catch (error) {
    console.error(
      `Network error fetching event ${id} from ${eventUrl}:`,
      error
    );
    return null;
  }
}

/**
 * Fetches events by their kind/category in batches.
 * @param kinds - An array of event kinds to fetch.
 * @param relayDb - The R2 bucket instance for database operations.
 * @param limit - The maximum number of events to fetch per kind.
 * @returns An array of promises resolving to NostrEvent objects or null if not found.
 */
async function fetchEventsByKind(
  kinds: number[],
  c: Context<{ Bindings: Bindings }>,
  limit = 25
): Promise<Promise<NostrEvent | null>[]> {
  console.log(`Fetching events by kinds: ${kinds} with limit: ${limit}`);

  const promises: Promise<NostrEvent | null>[] = [];
  try {
    const stmt = c.env.DB.prepare(`
      SELECT id, pubkey, created_at, kind, tags, content, sig, expires_at
      FROM events 
      WHERE kind IN (${kinds.join(",")})
      AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);

    const now = Math.floor(Date.now() / 1000);
    const results = await stmt.bind(now).all();

    if (results.results && results.results.length > 0) {
      console.log(
        `Found ${results.results.length} events in D1 for kinds: ${kinds}`
      );
      promises.push(
        ...parseD1ResultsToEvents(results.results, c.env.R2_BUCKET_DOMAIN)
      );
    }
  } catch (error) {
    console.error(`Error fetching from D1 for kinds ${kinds}:`, error);
  }

  return promises;
}

/**
 * Fetches events by their authors' public keys in batches.
 * @param authors - An array of author public keys to fetch events for.
 * @param relayDb - The R2 bucket instance for database operations.
 * @param limit - The maximum number of events to fetch per author.
 * @returns An array of promises resolving to NostrEvent objects or null if not found.
 */
async function fetchEventsByAuthor(
  authors: string[],
  c: Context<{ Bindings: Bindings }>,
  limit = 25
): Promise<Promise<NostrEvent | null>[]> {
  console.log(`Fetching events by authors: ${authors} with limit: ${limit}`);

  const promises: Promise<NostrEvent | null>[] = [];

  let hasCachedPubkey = false;
  try {
    hasCachedPubkey = authors.some(async (author) => {
      const cachedPubkey = await getFromKV(`cached/pubkey_${author}`, c);
      return cachedPubkey !== null;
    });
  } catch (error) {}

  const limitQuery = !hasCachedPubkey ? `LIMIT ${limit}` : ``;

  try {
    const stmt = c.env.DB.prepare(`
      SELECT id, pubkey, created_at, kind, tags, content, sig, expires_at
      FROM events 
      WHERE pubkey IN (${authors.map((a) => `'${a}'`).join(",")})
      AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
      ${limitQuery}
    `);

    const now = Math.floor(Date.now() / 1000);
    const results = await stmt.bind(now).all();

    if (results.results && results.results.length > 0) {
      console.log(
        `Found ${results.results.length} events in D1 for authors: ${authors}`
      );
      promises.push(
        ...parseD1ResultsToEvents(results.results, c.env.R2_BUCKET_DOMAIN)
      );
    }
  } catch (error) {
    console.error(`Error fetching from D1 for authors ${authors}:`, error);
  }

  return promises;
}

/**
 * Fetches events by specific tags in batches.
 * @param tags - An array of tag tuples [tagName, tagValue] to filter events.
 * @param relayDb - The R2 bucket instance for database operations.
 * @param limit - The maximum number of events to fetch per tag.
 * @returns An array of promises resolving to NostrEvent objects or null if not found.
 */
async function fetchEventsByTag(
  tags: [string, string][],
  c: Context<{ Bindings: Bindings }>,
  limit = 25
): Promise<Promise<NostrEvent | null>[]> {
  console.log(
    `Fetching events by tags: ${JSON.stringify(tags)} with limit: ${limit}`
  );

  const promises: Promise<NostrEvent | null>[] = [];
  try {
    for (const [tagName, tagValue] of tags) {
      const stmt = c.env.DB.prepare(`
        SELECT id, pubkey, created_at, kind, tags, content, sig, expires_at
        FROM events
        WHERE json_array_contains(tags, json_array(?, ?))
        AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);

      const now = Math.floor(Date.now() / 1000);
      const results = await stmt.bind(tagName, tagValue, now).all();

      if (results.results && results.results.length > 0) {
        console.log(
          `Found ${results.results.length} events in D1 for tag: ${tagName}-${tagValue}`
        );
        promises.push(
          ...parseD1ResultsToEvents(results.results, c.env.R2_BUCKET_DOMAIN)
        );
      }
    }
  } catch (error) {
    console.error(`Error fetching from D1 for tags:`, error);
  }
  return promises;
}

/**
 * Filters the fetched events based on additional criteria provided in the filters.
 * This ensures that only events fully matching all specified filters are returned.
 * @param events - An array of NostrEvent objects to filter.
 * @param filters - The filters to apply for selecting events.
 * @returns An array of NostrEvent objects that match all the filters.
 */
function filterEvents(events: NostrEvent[], filters: Filters): NostrEvent[] {
  console.log(`Filtering events based on filters: ${JSON.stringify(filters)}`);

  return events.filter((event) => {
    // Check for basic filters: ids, kinds, authors, created_at range
    const includeEvent =
      (!filters.ids || filters.ids.includes(event.id)) &&
      (!filters.kinds || filters.kinds.includes(event.kind)) &&
      (!filters.authors || filters.authors.includes(event.pubkey)) &&
      (!filters.since || event.created_at >= filters.since) &&
      (!filters.until || event.created_at <= filters.until);

    // Check for tag filters
    if (filters.tags) {
      for (const [tagName, tagValue] of filters.tags) {
        // Extract the values of the specified tag from the event's tags
        const eventTags = event.tags
          .filter(([t]) => t === tagName)
          .map(([, v]) => v);
        // If the event does not contain the required tag value, exclude it
        if (!eventTags.includes(tagValue)) {
          return false;
        }
      }
    }

    return includeEvent;
  });
}

async function getFromKV(
  key: string,
  c: Context<{ Bindings: Bindings }>
): Promise<string | null> {
  return await c.env.honostrKV.get(key);
}

// Export the Hono application as the default export
export default app;
