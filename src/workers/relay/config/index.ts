import { RelayConfig } from "./bindings";

const config = require("../../../../settings.json");
const typedConfig = config as RelayConfig;

// Extract configuration with proper typing
const { relayInfo, relayIcon, nip05Users } = typedConfig;

// Handles EVENT messages to helper workers
const eventHelpers = typedConfig.helpers.event;

// Handles REQ messages from helper workers
const reqHelpers = typedConfig.helpers.req;

// Convert arrays to Sets with proper typing
const blockedPubkeys = new Set<string>(typedConfig.pubkeys.blocked);
const allowedPubkeys = new Set<string>(typedConfig.pubkeys.allowed);
const blockedEventKinds = new Set<number>(typedConfig.eventKinds.blocked);
const allowedEventKinds = new Set<number>(typedConfig.eventKinds.allowed);
const blockedContent = new Set<string>(typedConfig.content.blocked);
const blockedNip05Domains = new Set<string>(typedConfig.nip05Domains.blocked);
const allowedNip05Domains = new Set<string>(typedConfig.nip05Domains.allowed);
const blockedTags = new Set<string>(typedConfig.tags.blocked);
const allowedTags = new Set<string>(typedConfig.tags.allowed);

export {
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
};
