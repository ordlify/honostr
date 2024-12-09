interface RelayInfo {
  name: string;
  description: string;
  pubkey: string;
  icon: string;
  contact: string;
  supported_nips: number[];
  software: string;
  version: string;
}

interface Helpers {
  event: string[];
  req: string[];
}

interface PubkeysConfig {
  blocked: string[];
  allowed: string[];
}

interface EventKindsConfig {
  blocked: number[];
  allowed: number[];
}

interface ContentConfig {
  blocked: string[];
}

interface Nip05DomainsConfig {
  blocked: string[];
  allowed: string[];
}

interface TagsConfig {
  blocked: string[];
  allowed: string[];
}

interface RelayConfig {
  relayInfo: RelayInfo;
  relayIcon: string;
  nip05Users: Record<string, string>;
  helpers: Helpers;
  pubkeys: PubkeysConfig;
  eventKinds: EventKindsConfig;
  content: ContentConfig;
  nip05Domains: Nip05DomainsConfig;
  tags: TagsConfig;
}

export type { RelayConfig };
