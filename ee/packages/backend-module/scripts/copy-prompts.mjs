#!/usr/bin/env node
// Copy the prompts/ directory into dist/ so the built package is
// self-contained when published or copied into a slimmer runtime image
// (e.g. a Docker stage that only carries dist/). The wizard service
// looks in both <packageRoot>/prompts and <packageRoot>/dist/prompts.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const source = path.join(packageRoot, "prompts");
const destination = path.join(packageRoot, "dist", "prompts");

try {
  await fs.access(source);
} catch {
  // No prompts to copy; nothing to do.
  process.exit(0);
}

await fs.rm(destination, { recursive: true, force: true });
await fs.cp(source, destination, { recursive: true });
