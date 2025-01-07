import { Bindings } from "./bindings";

async function initializeD1Database(
  c: Bindings
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log("Initializing D1 database...");

    // Create schema versions table if it doesn't exist
    await c.DB.prepare(
      `CREATE TABLE IF NOT EXISTS schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER
      )`
    ).run();

    // Check if this is a fresh database
    const tablesResult = await c.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`
    ).all();

    const isFreshDatabase = tablesResult.results?.length <= 1; // Only schema_versions exists

    if (isFreshDatabase) {
      console.log(
        "Fresh database detected, applying all migrations at once..."
      );
      // Apply all migrations in a single batch for fresh database
      await c.DB.batch([
        // Version 1: Events table
        c.DB.prepare(`
          CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            pubkey TEXT,
            created_at INTEGER,
            kind INTEGER,
            tags TEXT,
            content TEXT,
            sig TEXT,
            expires_at INTEGER
          )
        `),
        c.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pubkey ON events(pubkey)`),

        // Version 2: Counts table
        c.DB.prepare(`
          CREATE TABLE IF NOT EXISTS counts (
            key TEXT PRIMARY KEY,
            count INTEGER DEFAULT 0
          )
        `),
        c.DB.prepare(
          `CREATE INDEX IF NOT EXISTS idx_counts_key ON counts(key)`
        ),

        // Version 3: Metadata table
        c.DB.prepare(`
          CREATE TABLE IF NOT EXISTS metadata (
            event_id TEXT PRIMARY KEY,
            pubkey TEXT,
            created_at INTEGER,
            kind INTEGER,
            tags TEXT,
            expires_at INTEGER
          )
        `),
        c.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_kind ON metadata(kind)`),
        c.DB.prepare(
          `CREATE INDEX IF NOT EXISTS idx_pubkey ON metadata(pubkey)`
        ),

        // Record all migrations as complete
        c.DB.prepare(
          `INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)`
        ).bind(1, Math.floor(Date.now() / 1000)),
        c.DB.prepare(
          `INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)`
        ).bind(2, Math.floor(Date.now() / 1000)),
        c.DB.prepare(
          `INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)`
        ).bind(3, Math.floor(Date.now() / 1000)),
      ]);
      console.log("All migrations applied successfully");
      return { success: true };
    }
    // Check current schema version
    const versionResult = await c.DB.prepare(
      `
      SELECT MAX(version) as current_version FROM schema_versions
    `
    ).first();

    const currentVersion = Number(versionResult?.current_version) || 0;

    // Apply migrations sequentially
    if (currentVersion < 1) {
      // Version 1: Initial schema
      await c.DB.batch([
        c.DB.prepare(`
          CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            pubkey TEXT,
            created_at INTEGER,
            kind INTEGER,
            tags TEXT,
            content TEXT,
            sig TEXT,
            expires_at INTEGER
          )
        `),
        c.DB.prepare(`
          CREATE INDEX IF NOT EXISTS idx_pubkey ON events(pubkey)
        `),
        c.DB.prepare(
          `
          INSERT INTO schema_versions (version, applied_at) VALUES (1, ?)
        `
        ).bind(Math.floor(Date.now() / 1000)),
      ]);
      console.log("Applied database schema version 1");
    }

    if (currentVersion < 2) {
      // Version 2: Add counts table
      await c.DB.batch([
        c.DB.prepare(`
          CREATE TABLE IF NOT EXISTS counts (
            key TEXT PRIMARY KEY,
            count INTEGER DEFAULT 0
          )
        `),
        c.DB.prepare(`
          CREATE INDEX IF NOT EXISTS idx_counts_key ON counts(key)
        `),
        // Migrate existing counts from R2 if needed
        c.DB.prepare(
          `
          INSERT INTO schema_versions (version, applied_at) VALUES (2, ?)
        `
        ).bind(Math.floor(Date.now() / 1000)),
      ]);
      console.log("Applied database schema version 2");
    }

    if (currentVersion < 3) {
      await c.DB.batch([
        c.DB.prepare(`
          CREATE TABLE IF NOT EXISTS metadata (
            event_id TEXT PRIMARY KEY,
            pubkey TEXT,
            created_at INTEGER,
            kind INTEGER,
            tags TEXT,
            expires_at INTEGER
          )
        `),
        c.DB.prepare(`
          CREATE INDEX IF NOT EXISTS idx_kind ON metadata(kind)
        `),
        c.DB.prepare(`
          CREATE INDEX IF NOT EXISTS idx_pubkey ON metadata(pubkey)
        `),
        c.DB.prepare(
          `
          INSERT INTO schema_versions (version, applied_at) VALUES (3, ?)
        `
        ).bind(Math.floor(Date.now() / 1000)),
      ]);
      console.log("Applied database schema version 3");
    }

    return { success: true };
  } catch (error) {
    console.error(`Error initializing database: ${(error as Error).message}`);
    return {
      success: false,
      error: `Error initializing database: ${(error as Error).message}`,
    };
  }
}

export { initializeD1Database };
