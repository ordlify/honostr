// shared.ts

import { schnorr } from "@noble/curves/secp256k1";
import { NostrEvent, Filters, RequestMetadata, Bindings } from "./bindings";
import {
  eventHelpers,
  reqHelpers,
  blockedPubkeys,
  allowedPubkeys,
  blockedEventKinds,
  allowedEventKinds,
  blockedContent,
  blockedTags,
  allowedTags,
} from "./config";

export type CacheKey =
  | `event:${string}`
  | `req:${string}`
  | `metadata:${string}`;

export type SendFn = (wsId: string, message: any) => void;

// Validation functions
export function isPubkeyAllowed(pubkey: string): boolean {
  if (allowedPubkeys.size > 0 && !allowedPubkeys.has(pubkey)) return false;
  return !blockedPubkeys.has(pubkey);
}

export function isEventKindAllowed(kind: number): boolean {
  if (allowedEventKinds.size > 0 && !allowedEventKinds.has(kind)) return false;
  return !blockedEventKinds.has(kind);
}

export function containsBlockedContent(event: NostrEvent): boolean {
  if (!event.content) return false;

  const content = event.content.toLowerCase();
  return Array.from(blockedContent).some((blocked) =>
    content.includes(blocked.toLowerCase())
  );
}

export function isTagAllowed(tag: string): boolean {
  if (allowedTags.size > 0 && !allowedTags.has(tag)) return false;
  return !blockedTags.has(tag);
}

// Message sending functions
export function sendOK(
  sendFn: SendFn,
  wsId: string,
  eventId: string | null,
  status: boolean,
  message: string
) {
  sendFn(wsId, ["OK", eventId, status, message]);
}

export function sendError(sendFn: SendFn, wsId: string, message: string) {
  sendFn(wsId, ["NOTICE", message]);
}

export function sendEOSE(sendFn: SendFn, wsId: string, subscriptionId: string) {
  sendFn(wsId, ["EOSE", subscriptionId]);
}

// Event processing functions
export async function verifyEventSignature(
  event: NostrEvent
): Promise<boolean> {
  try {
    const signatureBytes = hexToBytes(event.sig);
    const serializedEventData = serializeEventForSigning(event);
    const messageHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(serializedEventData)
    );
    const messageHash = new Uint8Array(messageHashBuffer);
    const publicKeyBytes = hexToBytes(event.pubkey);
    return schnorr.verify(signatureBytes, messageHash, publicKeyBytes);
  } catch (error) {
    console.error("Error verifying event signature:", error);
    return false;
  }
}

export function hexToBytes(hexString: string): Uint8Array {
  if (hexString.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexString.substr(i * 2, 2), 16);
  }
  return bytes;
}

export function serializeEventForSigning(event: NostrEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

// Helper worker functions
export async function fetchEventsFromHelper(
  subscriptionId: string | null,
  filters: Filters,
  env: Bindings
): Promise<NostrEvent[]> {
  try {
    console.log(`Requesting events with filters:`, { subscriptionId, filters });

    const response = await env.REQ_WORKER.fetch("http://internal/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env?.AUTH_TOKEN || ""}`,
      },
      body: JSON.stringify({ type: "REQ", subscriptionId, filters }),
    });

    if (!response.ok) {
      console.error(`Error fetching events: ${response.status}`);
      throw new Error(`Failed to fetch events: ${response.status}`);
    }

    const events = await response.json();
    return Array.isArray(events) ? events : [];
  } catch (error) {
    console.error("Error in fetchEventsFromHelper:", error);
    return [];
  }
}

// Rate limiting
export class RateLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private readonly capacity: number;
  private readonly fillRate: number;

  constructor(rate: number, capacity: number) {
    this.tokens = capacity;
    this.lastRefillTime = Date.now();
    this.capacity = capacity;
    this.fillRate = rate;
  }

  removeToken(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedTime = now - this.lastRefillTime;
    const tokensToAdd = Math.floor(elapsedTime * this.fillRate);
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }
}

const rateLimiterMap = new Map<string, RateLimiter>();

export function getOrCreateRateLimiter(identifier: string): RateLimiter {
  if (!rateLimiterMap.has(identifier)) {
    rateLimiterMap.set(identifier, new RateLimiter(10 / 60000, 10)); // 10 tokens per minute
  }
  return rateLimiterMap.get(identifier)!;
}

// Filter matching
export function matchesFilters(event: NostrEvent, filters: Filters): boolean {
  // Quick checks first
  if (filters.ids?.length && !filters.ids.includes(event.id)) return false;
  if (filters.authors?.length && !filters.authors.includes(event.pubkey))
    return false;
  if (filters.kinds?.length && !filters.kinds.includes(event.kind))
    return false;
  if (filters.since && event.created_at < filters.since) return false;
  if (filters.until && event.created_at > filters.until) return false;

  // Tag matching optimization
  const tagEntries = Object.entries(filters).filter(([key]) =>
    key.startsWith("#")
  );
  if (tagEntries.length === 0) return true;

  // Create a map of event tags for faster lookup
  const eventTagMap = new Map<string, Set<string>>();
  for (const [tagName, tagValue] of event.tags) {
    if (!eventTagMap.has(tagName)) {
      eventTagMap.set(tagName, new Set());
    }
    eventTagMap.get(tagName)!.add(tagValue);
  }

  return tagEntries.every(([key, values]) => {
    const tagName = key.slice(1);
    const eventTagValues = eventTagMap.get(tagName);
    return (
      eventTagValues &&
      values.some((value: string) => eventTagValues.has(value))
    );
  });
}

// Background processing
export async function processEventInBackground(
  event: NostrEvent,
  requestMetadata: RequestMetadata,
  env: Bindings
): Promise<{ success: boolean; error?: string }> {
  try {
    // Fast validation first
    if (!event?.id || !event.pubkey || !event.created_at || !event.sig) {
      return { success: false, error: "Invalid event format" };
    }

    // Admin fast path - fire and forget
    if (requestMetadata.isAdmin) {
      // Don't await, just fire the request
      sendEventToHelper(eventHelpers, event, requestMetadata, env).catch(
        (error) => console.error(`Admin event error:`, error)
      );
      return { success: true };
    }

    // Regular event processing...
    if (!isPubkeyAllowed(event.pubkey))
      return { success: false, error: "Pubkey not allowed" };
    if (!isEventKindAllowed(event.kind))
      return { success: false, error: "Event kind not allowed" };
    if (event.kind > 1 && !getOrCreateRateLimiter(event.pubkey).removeToken()) {
      return { success: false, error: "Rate limit exceeded" };
    }

    if (!(await verifyEventSignature(event))) {
      return { success: false, error: "Invalid signature" };
    }

    if (containsBlockedContent(event)) {
      return { success: false, error: "Content not allowed" };
    }

    try {
      await sendEventToHelper(eventHelpers, event, requestMetadata, env);
      return { success: true };
    } catch (error) {
      console.error("Helper processing error:", error);
      return { success: false, error: "Helper processing failed" };
    }
  } catch (error) {
    console.error("Event processing error:", error);
    return { success: false, error: "Internal error" };
  }
}

export function sendEventToHelper(
  helpers: string[],
  event: NostrEvent,
  requestMetadata: RequestMetadata,
  env: Bindings
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env?.AUTH_TOKEN || ""}`,
  };

  if (requestMetadata.cached) {
    headers["Cache-Event"] = "true";
  }

  // Using service binding with a proper URL
  return env.EVENT_WORKER.fetch("http://event-worker/", {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "EVENT", event }),
  }).then(async (response) => {
    if (!response.ok) {
      const responseBody = await response.text();
      console.error(`Publish error: ${responseBody}`);
    }
  });
}
