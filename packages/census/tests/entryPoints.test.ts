import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What each published entry point is allowed to pull in when a consumer imports it.
 *
 * census is a pure, dependency-free algorithm package: it must be safe to import from
 * anywhere (backend, worker, edge runtimes) without pulling in any other module in the
 * monorepo or on npm. That claim is only true if it holds at the entry point, so it is
 * asserted here rather than left to per-file import conventions — every individual
 * import in this package is defensible where it sits; only the reachable graph shows
 * the coupling.
 *
 * An empty budget means zero non-builtin external modules are permitted, transitively.
 * Adding a dependency fails this test until someone widens the budget here, which is the
 * intended review moment — and for census, the answer should always be "don't."
 */
const ALLOWED_EXTERNALS: Record<string, readonly string[]> = {
  ".": [],
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

const traceEntryPoint = (distPath: string): { external: string[]; moduleCount: number } => {
  const distUrl = new URL(distPath, `file://${packageDir}`);
  if (!existsSync(distUrl)) {
    throw new Error(
      `${distPath} does not exist. Run "pnpm --dir packages/census run build" first. `
      + '("pnpm test" and "pnpm run test" trigger the pretest build automatically; '
      + '"pnpm exec vitest" does not, and will hit this error against a stale or missing dist.)',
    );
  }
  return JSON.parse(execFileSync("node", [tracer, distUrl.pathname], {
    encoding: "utf8",
    cwd: packageDir,
  })) as { external: string[]; moduleCount: number };
};

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
        `importing "@radioso/census${key.slice(1)}" loads ${moduleCount} modules and reaches `
        + `${unbudgeted.length} dependencies outside its budget: ${unbudgeted.join(", ")}. `
        + "census must ship with zero runtime dependencies. Remove the import, or widen the "
        + "budget in ALLOWED_EXTERNALS if it is truly a Node builtin or relative module "
        + "misclassified as external.",
      ).toEqual([]);
    });
  }
});
