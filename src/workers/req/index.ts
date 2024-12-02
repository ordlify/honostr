// workers/req/index.ts
import { Hono } from "hono";
import { Context } from "hono";
import { Bindings } from "./bindings";

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface Filters {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  tags?: [string, string][];
  [key: string]: any;
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

app.post("/", async (c: Context<{ Bindings: Bindings }>) => {
  try {
    // Checks if Authorization header is present and matches AUTH_TOKEN
    const authHeader = c.req.header("Authorization");
    console.log(`Authorization header received: ${authHeader !== null}`);

    if (!authHeader || authHeader !== `Bearer ${c.env.AUTH_TOKEN}`) {
      console.warn("Unauthorized request.");
      return c.text("Unauthorized", 401);
    }

    const { type, subscriptionId, filters } = await c.req.json();

    console.log(`Request type: ${type}, Subscription ID: ${subscriptionId}`);

    if (type === "REQ") {
      console.log(`Processing REQ with filters: ${JSON.stringify(filters)}`);
      const events = await processReq(subscriptionId, filters, c);
      console.log(
        `Returning ${events.length} events for subscription ID: ${subscriptionId}`
      );
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

// Handles REQ messages with batching
async function processReq(
  subscriptionId: string,
  filters: Filters,
  c: Context<{ Bindings: Bindings }>
): Promise<NostrEvent[]> {
  console.log(`Processing request for subscription ID: ${subscriptionId}`);

  let events: NostrEvent[] = [];
  const eventPromises: Promise<NostrEvent | null>[] = [];

  // Fetch events in batches
  try {
    if (filters.ids) {
      console.log(`Fetching events by IDs: ${filters.ids}`);
      eventPromises.push(
        ...fetchEventsById(filters.ids, c.env.R2_BUCKET_DOMAIN)
      );
    }
    if (filters.kinds) {
      console.log(`Fetching events by kinds: ${filters.kinds}`);
      eventPromises.push(
        ...(await fetchEventsByKind(filters.kinds, c.env.relayDb))
      );
    }
    if (filters.authors) {
      console.log(`Fetching events by authors: ${filters.authors}`);
      eventPromises.push(
        ...(await fetchEventsByAuthor(filters.authors, c.env.relayDb))
      );
    }
    if (filters.tags) {
      console.log(`Fetching events by tags: ${JSON.stringify(filters.tags)}`);
      eventPromises.push(
        ...(await fetchEventsByTag(filters.tags, c.env.relayDb))
      );
    }

    const fetchedEvents = await Promise.all(eventPromises);
    console.log(`Fetched ${fetchedEvents.length} events, applying filters...`);
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

// Fetch events by IDs in batches
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
    batches.push(...batch.map((id) => fetchEventById(id, r2BucketDomain)));
  }
  return batches;
}

// Fetch a single event by ID
async function fetchEventById(
  id: string,
  r2BucketDomain: string
): Promise<NostrEvent | null> {
  const idKey = `events/event:${id}`;
  const eventUrl = `https://${r2BucketDomain}/${idKey}`;
  console.log(`Fetching event by ID: ${id} from ${eventUrl}`);

  try {
    return withConnectionLimit(async () => {
      const response = await fetch(eventUrl);
      if (!response.ok) {
        console.warn(`Event not found for ID: ${id}`);
        return null;
      }
      const data = await response.text();
      console.log(`Event found for ID: ${id}`);
      return JSON.parse(data) as NostrEvent;
    });
  } catch (error) {
    console.error(`Error fetching event with ID ${id}:`, error);
    return null;
  }
}

// Fetch events by kind in batches
async function fetchEventsByKind(
  kinds: number[],
  relayDb: R2Bucket,
  limit = 25
): Promise<Promise<NostrEvent | null>[]> {
  console.log(`Fetching events by kinds: ${kinds} with limit: ${limit}`);

  const promises: Promise<NostrEvent | null>[] = [];
  for (const kind of kinds) {
    const kindCountKey = `counts/kind_count_${kind}`;
    console.log(`Fetching kind count for kind: ${kind}`);

    const kindCountResponse = await withConnectionLimit(() =>
      relayDb.get(kindCountKey)
    );
    const kindCountValue = kindCountResponse
      ? await kindCountResponse.text()
      : "0";
    const kindCount = parseInt(kindCountValue, 10);
    console.log(`Found ${kindCount} events for kind: ${kind}`);

    for (let i = kindCount; i >= Math.max(1, kindCount - limit + 1); i--) {
      const kindKey = `kinds/kind-${kind}:${i}`;
      promises.push(fetchEventByKey(kindKey, relayDb));
    }
  }
  return promises;
}

// Fetch events by author in batches
async function fetchEventsByAuthor(
  authors: string[],
  relayDb: R2Bucket,
  limit = 25
): Promise<Promise<NostrEvent | null>[]> {
  console.log(`Fetching events by authors: ${authors} with limit: ${limit}`);

  const promises: Promise<NostrEvent | null>[] = [];
  for (const author of authors) {
    const pubkeyCountKey = `counts/pubkey_count_${author}`;
    console.log(`Fetching pubkey count for author: ${author}`);

    const pubkeyCountResponse = await withConnectionLimit(() =>
      relayDb.get(pubkeyCountKey)
    );
    const pubkeyCountValue = pubkeyCountResponse
      ? await pubkeyCountResponse.text()
      : "0";
    const pubkeyCount = parseInt(pubkeyCountValue, 10);
    console.log(`Found ${pubkeyCount} events for author: ${author}`);

    for (let i = pubkeyCount; i >= Math.max(1, pubkeyCount - limit + 1); i--) {
      const pubkeyKey = `pubkeys/pubkey-${author}:${i}`;
      promises.push(fetchEventByKey(pubkeyKey, relayDb));
    }
  }
  return promises;
}

// Fetch events by tag in batches
async function fetchEventsByTag(
  tags: [string, string][],
  relayDb: R2Bucket,
  limit = 25
): Promise<Promise<NostrEvent | null>[]> {
  console.log(
    `Fetching events by tags: ${JSON.stringify(tags)} with limit: ${limit}`
  );

  const promises: Promise<NostrEvent | null>[] = [];
  for (const [tagName, tagValue] of tags) {
    const tagCountKey = `counts/${tagName}_count_${tagValue}`;
    console.log(`Fetching tag count for tag: ${tagName}-${tagValue}`);

    const tagCountResponse = await withConnectionLimit(() =>
      relayDb.get(tagCountKey)
    );
    const tagCountValue = tagCountResponse
      ? await tagCountResponse.text()
      : "0";
    const tagCount = parseInt(tagCountValue, 10);
    console.log(`Found ${tagCount} events for tag: ${tagName}-${tagValue}`);

    for (let i = tagCount; i >= Math.max(1, tagCount - limit + 1); i--) {
      const tagKey = `tags/${tagName}-${tagValue}:${i}`;
      promises.push(fetchEventByKey(tagKey, relayDb));
    }
  }
  return promises;
}

// Fetch event by key (common for kind, author, etc.)
async function fetchEventByKey(
  eventKey: string,
  relayDb: R2Bucket
): Promise<NostrEvent | null> {
  console.log(`Fetching event by key: ${eventKey}`);

  try {
    return withConnectionLimit(async () => {
      const object = await relayDb.get(eventKey);
      if (!object) {
        console.warn(`Event not found for key: ${eventKey}`);
        return null;
      }
      const data = await object.text();
      console.log(`Event found for key: ${eventKey}`);
      return JSON.parse(data) as NostrEvent;
    });
  } catch (error) {
    console.error(`Error fetching event with key ${eventKey}:`, error);
    return null;
  }
}

// Filter events based on additional filters
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
        const eventTags = event.tags
          .filter(([t]) => t === tagName)
          .map(([, v]) => v);
        if (!eventTags.includes(tagValue)) {
          return false;
        }
      }
    }

    return includeEvent;
  });
}

export default app;
