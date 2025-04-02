import { Hono } from "hono";
import { finalizeEvent } from "nostr-tools";
import { Bindings } from "./bindings";

// Initialize a new Hono application
const app = new Hono<{ Bindings: Bindings }>();

app.post("/publish-event", async (c) => {
  // Retrieve the Authorization header from the request
  const authHeader = c.req.header("Authorization");
  console.log(`Authorization header received: ${authHeader !== null}`);

  console.log(authHeader, "authHeader");
  console.log(c.env.AUTH_TOKEN, "AUTH_TOKEN");

  // Validate the Authorization header against the expected AUTH_TOKEN
  if (!authHeader || authHeader !== `Bearer ${c.env.AUTH_TOKEN}`) {
    console.warn("Unauthorized request.");
    return c.text("Unauthorized", 401);
  }

  const { tags, content, secKey, kind } = await c.req.json();
  const eventData = {
    created_at: Math.floor(Date.now() / 1000),
    kind: kind,
    tags: tags,
    content: content,
  };

  const signedEvent = finalizeEvent(eventData, hexToBytes(secKey));

  try {
    const response: any = await publishEvent(signedEvent);
    if (isSuccessfulResponse(response)) {
      console.log(response, "response");
      return c.json({ eventId: signedEvent.id, success: true });
    } else {
      return c.text("Failed to publish event", 500);
    }
  } catch (error) {
    console.error("Error publishing event:", error);
    return c.text("Failed to publish event", 500);
  }
});

async function publishEvent(eventData: any) {
  console.log("Publishing event:", eventData);
  return new Promise((resolve, reject) => {
    const urlWithParams = `wss://nostr.ovia.to`;

    const ws: WebSocket = new WebSocket(urlWithParams);

    ws.addEventListener("open", () => {
      console.log("WebSocket opened.");

      ws.send(JSON.stringify(["EVENT", eventData]));
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      console.log("Received message from server:", event.data);
      try {
        const parsedData = JSON.parse(event.data);
        if (Array.isArray(parsedData)) {
          resolve(parsedData);
        } else {
          reject(new Error("Invalid response format"));
        }
      } catch (error) {
        reject(error);
      }
    });

    ws.addEventListener("error", (error: Event) => {
      console.error("WebSocket error:", error);
      reject(error);
    });

    ws.addEventListener("close", () => {
      console.log("WebSocket connection closed.");
    });
  });
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

/**
 * Checks if an array contains both "OK" and true as members.
 * @param response - The array to check.
 * @returns A boolean indicating whether both "OK" and true are present in the array.
 */
function isSuccessfulResponse(response: any[]): boolean {
  return response.includes("OK") && response.includes(true);
}

// Export the Hono application as the default export
export default app;
