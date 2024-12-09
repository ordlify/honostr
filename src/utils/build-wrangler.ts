import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

interface EnvVars {
  AUTH_TOKEN: string;
  API_TOKEN: string;
  ZONE_ID: string;
  R2_BUCKET_DOMAIN: string;
  ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  COMPATIBILITY_DATE: string;
  AUTH_SECRET?: string;
  ENABLE_LOGGING?: string;
}

const requiredEnvVars: (keyof EnvVars)[] = [
  "AUTH_TOKEN",
  "API_TOKEN",
  "ZONE_ID",
  "R2_BUCKET_DOMAIN",
  "ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "COMPATIBILITY_DATE",
  "AUTH_SECRET",
];

const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);

if (missingVars.length > 0) {
  console.error(`Missing environment variables: ${missingVars.join(", ")}`);
  process.exit(1);
}

const {
  AUTH_TOKEN,
  API_TOKEN,
  ZONE_ID,
  R2_BUCKET_DOMAIN,
  ACCOUNT_ID,
  R2_BUCKET_NAME,
  COMPATIBILITY_DATE,
  AUTH_SECRET,
  ENABLE_LOGGING,
} = process.env as unknown as EnvVars;

const workers = ["relay", "req", "event"];

workers.forEach((worker) => {
  let config = `
name = "${worker}-worker"
main = "index.ts"
compatibility_date = "${COMPATIBILITY_DATE}"
account_id = "${ACCOUNT_ID}"
`;

  let vars = {
    AUTH_TOKEN,
    R2_BUCKET_DOMAIN,
    API_TOKEN,
    ZONE_ID,
    AUTH_SECRET,
  };

  if (worker === "req") {
    vars.API_TOKEN = "";
    vars.ZONE_ID = "";
  }

  if (AUTH_SECRET) {
    vars = { ...vars, AUTH_SECRET };
  }

  const varsEntries = Object.entries(vars)
    .map(([key, value]) => `${key} = "${value}"`)
    .join("\n");

  const varsSection = `
[vars]
${varsEntries}
`;

  const r2BucketConfig = `
[[r2_buckets]]
binding = "relayDb"
bucket_name = "${R2_BUCKET_NAME}"
`;

  const loggingConfig = ENABLE_LOGGING
    ? `
[observability.logs]
enabled = true
`
    : "";

  const finalConfig = `${config.trim()}

${varsSection.trim()}

${r2BucketConfig.trim()}

${loggingConfig.trim()}
`;

  fs.writeFileSync(
    path.join(__dirname, "..", "..", "src", "workers", worker, "wrangler.toml"),
    finalConfig.trim()
  );
  console.log(`Generated wrangler.toml for ${worker} worker.`);
});
