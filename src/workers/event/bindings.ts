export interface Bindings {
  AUTH_TOKEN: string;
  API_TOKEN: string;
  ZONE_ID: string;
  R2_BUCKET_DOMAIN: string;
  relayDb: R2Bucket;
}

export interface Metadata {
  kindKey: string;
  pubkeyKey: string;
  contentHashKey: string;
  tags: string[];
}