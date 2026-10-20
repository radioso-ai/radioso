import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectoryOf = (directory: string): string => {
  if (existsSync(join(directory, "package.json"))) return directory;
  const parent = dirname(directory);
  return parent === directory ? directory : packageDirectoryOf(parent);
};

/**
 * Where the local provider's adapters spool mail: `.email-spool` in the backend package
 * (gitignored), from source or from the build, so the API, the worker and `email:dev` share it
 * whatever directory they start in.
 */
export const LOCAL_EMAIL_SPOOL_DIR = join(packageDirectoryOf(dirname(fileURLToPath(import.meta.url))), ".email-spool");
