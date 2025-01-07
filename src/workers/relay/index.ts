import { RelayCache } from "./RelayCache.do";
export { RelayCache };

import { Hono } from "hono";
import { Context } from "hono";
import { Bindings } from "./bindings";
import { relayInfo, relayIcon, nip05Users } from "./config";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", async (c) => {
  return c.req.header("Accept")?.includes("application/nostr+json")
    ? handleRelayInfoRequest(c)
    : c.text("Connect using a Nostr client");
});

app.get("/.well-known/nostr.json", async (c) => handleNIP05Request(c));
app.get("/favicon.ico", async (c) => serveFavicon(c));

export default {
  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Validate WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }

      // Get Durable Object stub
      const id = env.RELAY_CACHE.idFromName("Default");
      const obj = env.RELAY_CACHE.get(id);

      // Forward to Durable Object for WebSocket handling
      return obj.fetch(request);
    }

    // Handle other HTTP requests (assuming `app` is defined elsewhere)
    return app.fetch(request, env, ctx);
  },
};

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

function getShardKey(request: Request): string {
  // Get client IP or other identifier
  const clientId =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Real-IP") ||
    crypto.randomUUID();
  console.log(
    `Client: ${clientId}: ${request.headers.get("CF-Connecting-IP")}`
  );

  // Use a consistent hash function to distribute load
  const hash = new TextEncoder().encode(clientId).reduce((a, b) => a + b, 0);
  const shardId = Math.abs(hash % 100); // Use 100 shards
  return shardId.toString().padStart(2, "0");
}
