// Load and parse config file
const config = require("../../../../settings.json");

// Extract configuration
const { relayInfo, relayIcon, nip05Users } = config;

// Handles EVENT messages to helper workers
const eventHelpers = config.helpers.event;

// Handles REQ messages from helper workers
const reqHelpers = config.helpers.req;

// Convert arrays to Sets
const blockedPubkeys = new Set(config.pubkeys.blocked);
const allowedPubkeys = new Set(config.pubkeys.allowed);
const blockedEventKinds = new Set(config.eventKinds.blocked);
const allowedEventKinds = new Set(config.eventKinds.allowed);
const blockedContent = new Set(config.content.blocked);
const blockedNip05Domains = new Set(config.nip05Domains.blocked);
const allowedNip05Domains = new Set(config.nip05Domains.allowed);
const blockedTags = new Set(config.tags.blocked);
const allowedTags = new Set(config.tags.allowed);

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
