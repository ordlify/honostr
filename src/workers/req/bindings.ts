// workers/req/bindings.ts
export interface Bindings {
  AUTH_TOKEN: string;
  R2_BUCKET_DOMAIN: string;
  relayDb: R2Bucket;
  honostrKV: KVNamespace;
  DB: D1Database;
}
