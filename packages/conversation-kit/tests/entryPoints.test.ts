import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What each published entry point is allowed to pull in when a consumer imports it.
 *
 * The kit is provider-neutral wiring: a host brings its own `modelGateway`, its own
 * transport, and its own persistence. That claim is only true if it holds at the entry
 * point, so it is asserted here rather than left to per-file import conventions — every
 * individual import in this package is defensible where it sits; only the reachable graph
 * shows the coupling. `.` staying free of `node:*` is also what lets the kit run on
 * runtimes that have no filesystem or `node:http` (Workers, Deno Deploy, the browser).
 *
 * Budgets are cumulative where an entry re-exports the core, and asserted as a subset:
 * adding a dependency fails this test until someone widens the budget here, which is the
 * intended review moment.
 */
const CORE = ["@radioso/conversation-defaults", "@radioso/conversation-engine"];

const ALLOWED_EXTERNALS: Record<string, readonly string[]> = {
  ".": CORE,
  "./server": [...CORE, "node:events", "node:http"],
  "./node": ["node:fs", "node:path"],
};

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const tracer = fileURLToPath(new URL("./support/traceEntry.mjs", import.meta.url));

interface PackageManifest {
  exports: Record<string, { import?: string }>;
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

const entryPoints = Object.entries(manifest.exports)
  .filter((entry): entry is [string, { import: string }] => typeof entry[1].import === "string");

const traceEntryPoint = (distPath: string): { external: string[]; moduleCount: number } =>
  JSON.parse(execFileSync("node", [tracer, new URL(distPath, `file://${packageDir}`).pathname], {
    encoding: "utf8",
    cwd: packageDir,
  })) as { external: string[]; moduleCount: number };

describe("published entry points", () => {
  it("declares an import budget for every entry point in the exports map", () => {
    expect(entryPoints.map(([key]) => key).sort())
      .toEqual(Object.keys(ALLOWED_EXTERNALS).filter((key) => manifest.exports[key]).sort());
  });

  for (const [key, target] of entryPoints) {
    it(`"${key}" imports nothing outside its budget`, () => {
      const budget = ALLOWED_EXTERNALS[key];
      expect(budget, `no import budget declared for exports key "${key}"`).toBeDefined();

      const { external, moduleCount } = traceEntryPoint(target.import);
      const unbudgeted = external.filter((specifier) => !budget.includes(specifier));

      expect(
        unbudgeted,
        `importing "@radioso/conversation-kit${key.slice(1)}" loads ${moduleCount} modules and reaches `
        + `${unbudgeted.length} dependencies outside its budget: ${unbudgeted.join(", ")}. `
        + "Move the coupling behind its own entry point, or widen the budget in ALLOWED_EXTERNALS.",
      ).toEqual([]);
    });
  }
});
