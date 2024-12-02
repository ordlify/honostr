// Relay info (NIP-11)
const relayInfo = {
  name: "Nosflare",
  description:
    "A serverless Nostr relay through Cloudflare Worker and R2 bucket",
  pubkey: "d49a9023a21dba1b3c8306ca369bf3243d8b44b8f0b6d1196607f7b0990fa8df",
  contact: "lux@censorship.rip",
  supported_nips: [1, 2, 4, 5, 9, 11, 12, 15, 16, 17, 20, 22, 33, 40],
  software: "https://github.com/Spl0itable/nosflare",
  version: "4.22.30",
};

// Relay favicon
const relayIcon = "https://cdn-icons-png.flaticon.com/128/426/426833.png";

// Nostr address NIP-05 verified users
const nip05Users: Record<string, string> = {
  lux: "d49a9023a21dba1b3c8306ca369bf3243d8b44b8f0b6d1196607f7b0990fa8df",
  // ... more NIP-05 verified users
};

// Handles EVENT messages to helper workers
const eventHelpers = [
  "https://event-helper-1.example.com",
  "https://event-helper-2.example.com",
  // ... add more helper workers
];

// Handles REQ messages from helper workers
const reqHelpers = [
  "https://req-helper-1.example.com",
  "https://req-helper-2.example.com",
  // ... add more helper workers
];

// Blocked and allowed pubkeys
const blockedPubkeys = new Set<string>([
  "3c7f5948b5d80900046a67d8e3bf4971d6cba013abece1dd542eca223cf3dd3f",
  "fed5c0c3c8fe8f51629a0b39951acdf040fd40f53a327ae79ee69991176ba058",
  "e810fafa1e89cdf80cced8e013938e87e21b699b24c8570537be92aec4b12c18",
  "05aee96dd41429a3ae97a9dac4dfc6867fdfacebca3f3bdc051e5004b0751f01",
  "53a756bb596055219d93e888f71d936ec6c47d960320476c955efd8941af4362",
]);

const allowedPubkeys = new Set<string>([
  // ... pubkeys that are explicitly allowed
]);

// Blocked and allowed event kinds
const blockedEventKinds = new Set<number>([1064]);

const allowedEventKinds = new Set<number>([
  // ... kinds that are explicitly allowed
]);

// Blocked content phrases
const blockedContent = new Set<string>([
  "~~ hello world! ~~",
  // ... more blocked content
]);

// Blocked and allowed NIP-05 domains
const blockedNip05Domains = new Set<string>([
  // ... domains that are explicitly blocked
]);

const allowedNip05Domains = new Set<string>([
  // ... domains that are explicitly allowed
]);

// Blocked and allowed tags
const blockedTags = new Set<string>([
  // ... tags that are explicitly blocked
]);

const allowedTags = new Set<string>([
  // ... tags that are explicitly allowed
]);

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
