import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Prints the external modules an entry point pulls in when it is imported, as JSON:
// { external: string[], moduleCount: number }. Runs as its own process so each entry
// point is measured against a cold module registry.
//
// Uses the real loader rather than parsing the emitted JavaScript, so the answer is
// exactly what a consumer gets. A `resolve` hook fires for the whole *static* graph at
// link time but only fires for `await import()` when that branch actually runs, so a
// deliberately lazy dependency is correctly not counted as a load-time cost.
const [, , entry] = process.argv;
const sinkDir = mkdtempSync(join(tmpdir(), "census-entry-graph-"));
const sink = join(sinkDir, "specifiers.txt");
writeFileSync(sink, "");

register(new URL("./entryGraphHook.mjs", import.meta.url), { data: { sink } });
await import(entry);

const seen = [...new Set(readFileSync(sink, "utf8").split("\n").filter(Boolean))];
rmSync(dirname(sink), { recursive: true, force: true });

const isExternal = (specifier) =>
  !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:");

process.stdout.write(JSON.stringify({
  external: seen.filter(isExternal).sort(),
  moduleCount: seen.length,
}));
