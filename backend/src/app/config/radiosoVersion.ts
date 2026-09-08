import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const BACKEND_PACKAGE_NAME = "radioso-backend";
const SEARCH_DEPTH = 6;

/**
 * The version of Radioso this process is. Deployment stamps `RADIOSO_RELEASE` with the
 * tag the release tooling cut; an unstamped build falls back to the backend package's own
 * version, which is what the release tooling reads to produce that tag in the first place.
 *
 * `null` means the question has no answer here, and callers that gate on compatibility
 * fail closed rather than guessing.
 */
export const resolveRunningRadiosoVersion = (release: string | undefined): string | null => {
  const stamped = release?.trim();
  if (stamped && SEMANTIC_VERSION.test(stamped)) return stamped;
  return backendPackageVersion();
};

/**
 * Walks up from this module looking for the backend package, because the compiled tree
 * and the source tree sit at different depths below it and the name is what makes the
 * answer unambiguous either way.
 */
const backendPackageVersion = (): string | null => {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < SEARCH_DEPTH; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === BACKEND_PACKAGE_NAME
        && typeof parsed.version === "string"
        && SEMANTIC_VERSION.test(parsed.version)) {
        return parsed.version;
      }
    } catch {
      // No package.json at this level, or one this process may not read. Keep walking.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
};
