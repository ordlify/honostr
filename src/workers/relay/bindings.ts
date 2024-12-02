export interface Bindings {
  AUTH_TOKEN: string;
  API_TOKEN: string;
  ZONE_ID: string;
  R2_BUCKET_DOMAIN: string;
  relayDb: R2Bucket;
}

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type Filters = {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [key: string]: any;
};
