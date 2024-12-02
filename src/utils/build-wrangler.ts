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
}

const requiredEnvVars: (keyof EnvVars)[] = [
  "AUTH_TOKEN",
  "API_TOKEN",
  "ZONE_ID",
  "R2_BUCKET_DOMAIN",
  "ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "COMPATIBILITY_DATE",
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
  };

  if (worker === "req") {
    vars.API_TOKEN = "";
    vars.ZONE_ID = "";
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

  const finalConfig = `${config.trim()}

${varsSection.trim()}

${r2BucketConfig.trim()}
`;

  fs.writeFileSync(
    path.join(__dirname, "..", "..", "src", "workers", worker, "wrangler.toml"),
    finalConfig.trim()
  );
  console.log(`Generated wrangler.toml for ${worker} worker.`);
});
