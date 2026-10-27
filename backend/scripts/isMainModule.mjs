import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when `moduleUrl` is the script node was started with. Compares real file URLs, so a
 * checkout path with spaces or non-ASCII characters, or a symlinked script, still matches; a
 * raw `file://${argv[1]}` comparison misses those and the guard script silently does nothing.
 */
export const isMainModule = (moduleUrl) =>
  process.argv[1] !== undefined && moduleUrl === pathToFileURL(realpathSync(process.argv[1])).href;
