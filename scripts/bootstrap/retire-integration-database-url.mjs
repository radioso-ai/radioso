import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readEnvFileSource,
  removeRetiredEnvAssignments,
  writeEnvFileAtomic,
} from "./env-file.mjs";

export const retireIntegrationDatabaseUrl = async (
  envPath = path.join(process.cwd(), ".env"),
) => {
  const source = await readEnvFileSource(envPath);
  if (source === null) {
    return false;
  }

  const cleaned = removeRetiredEnvAssignments(source);
  if (cleaned === source) {
    return false;
  }

  await writeEnvFileAtomic(envPath, cleaned);
  return true;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (await retireIntegrationDatabaseUrl()) {
    process.stdout.write("Removed retired INTEGRATION_DATABASE_URL from .env.\n");
  }
}
