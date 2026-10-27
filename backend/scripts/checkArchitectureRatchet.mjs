#!/usr/bin/env node
/**
 * Architecture ratchet.
 *
 * dependency-cruiser.config.cjs holds the boundary rules the codebase already meets, as errors.
 * Two rules in AGENTS.md are not met yet, so an error rule would fail every build or never be
 * turned on, and a warning would print every known offence on every lint run:
 *
 *   - Modules must not form import cycles. Dependency direction only means something when the
 *     module graph is acyclic; inside a cycle every module can reach every other.
 *   - Dependency direction: `src/modules` never imports `src/app`, and `src/shared` imports
 *     neither (DIRECTION_RULES below).
 *
 * This records today's offences in architectureRatchetBaseline.json and fails on any new one.
 * Cycles are checked between modules, not files: a file-level cycle baseline names the exact
 * cycle, which shifts whenever an unrelated import creates a shorter path through the same
 * files. A module edge is a direct import from one module's files into another's; a path that
 * runs through `src/db` repositories (which import module types, and are imported by modules)
 * is outside this check.
 *
 * Direction findings are keyed by the importing area (`modules/auth`, `shared/infra`) and the
 * imported file, so splitting or moving a file inside its module keeps its baselined entry.
 *
 * The baseline only shrinks. An entry that no longer occurs fails the build until it is
 * re-recorded with `--update`, so a fixed edge cannot quietly re-exempt the same edge later.
 * `--update` refuses to add entries unless `--allow-growth` is passed, so recording growth is
 * a deliberate act a reviewer sees in the diff.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./isMainModule.mjs";

export const DIRECTION_RULES = [
  {
    name: "no-module-imports-app",
    from: /^src\/modules\//,
    to: /^src\/app\//,
    remedy:
      "the application layer (composition, server, HTTP, config) assembles modules, so modules never import it; take the dependency as a constructor or route-factory argument wired in src/app/",
  },
  {
    name: "no-shared-imports-modules",
    from: /^src\/shared\//,
    to: /^src\/modules\//,
    remedy:
      "src/shared sits below every module, so it never imports one; move the shared type into src/shared, or move the code that needs the module into that module",
  },
  {
    name: "no-shared-imports-app",
    from: /^src\/shared\//,
    to: /^src\/app\//,
    remedy:
      "src/shared sits below the application layer, so it never imports it; take configuration as an argument from the caller in src/app/",
  },
];

const MODULE_CYCLE = "module-cycle";
const MODULE_PATH = /^src\/modules\/([^/]+)\//;
const IMPORTING_AREA = /^src\/(modules|shared)\/(?:([^/]+)\/)?/;

/** `src/modules/auth/services/x.ts` -> `modules/auth`; `src/shared/infra/llm/y.ts` -> `shared/infra`. */
const importingAreaOf = (source) => {
  const [, layer, area] = IMPORTING_AREA.exec(source) ?? [];
  return area ? `${layer}/${area}` : layer;
};

const byKey = (left, right) => left.key.localeCompare(right.key);
const sortedUnique = (values) => [...new Set(values)].sort();

export const moduleEdgesFrom = (cruiseResult) => {
  const keys = new Set();
  for (const module of cruiseResult.modules) {
    const from = MODULE_PATH.exec(module.source)?.[1];
    if (!from) continue;
    for (const dependency of module.dependencies) {
      const to = MODULE_PATH.exec(dependency.resolved)?.[1];
      if (to && to !== from) keys.add(`${from} -> ${to}`);
    }
  }
  return sortedUnique(keys).map((key) => {
    const [from, to] = key.split(" -> ");
    return { from, to };
  });
};

const adjacencyOf = (edges) => {
  const adjacency = new Map();
  for (const { from, to } of edges) {
    if (!adjacency.has(from)) adjacency.set(from, []);
    if (!adjacency.has(to)) adjacency.set(to, []);
    adjacency.get(from).push(to);
  }
  return adjacency;
};

/** Tarjan's algorithm; returns node -> component id. */
const stronglyConnectedComponents = (adjacency) => {
  const component = new Map();
  const index = new Map();
  const lowLink = new Map();
  const stack = [];
  const onStack = new Set();
  let counter = 0;

  const visit = (node) => {
    index.set(node, counter);
    lowLink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node)) {
      if (!index.has(next)) {
        visit(next);
        lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(next)));
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node), index.get(next)));
      }
    }
    if (lowLink.get(node) !== index.get(node)) return;
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.set(member, node);
    } while (member !== node);
  };

  for (const node of adjacency.keys()) if (!index.has(node)) visit(node);
  return component;
};

const shortestPath = (adjacency, start, goal) => {
  const previous = new Map([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === goal) break;
    for (const next of adjacency.get(node)) {
      if (previous.has(next)) continue;
      previous.set(next, node);
      queue.push(next);
    }
  }
  const path = [];
  for (let node = goal; node !== null; node = previous.get(node)) path.unshift(node);
  return path;
};

/** Every module edge that lies on a cycle, with the path back that closes it. */
export const findCyclicModuleEdges = (edges) => {
  const adjacency = adjacencyOf(edges);
  const component = stronglyConnectedComponents(adjacency);
  return edges
    .filter(({ from, to }) => component.get(from) === component.get(to))
    .map(({ from, to }) => ({ key: `${from} -> ${to}`, closedBy: shortestPath(adjacency, to, from) }))
    .sort(byKey);
};

export const directionViolationsFrom = (cruiseResult) =>
  Object.fromEntries(
    DIRECTION_RULES.map((rule) => {
      const keys = [];
      for (const module of cruiseResult.modules) {
        if (!rule.from.test(module.source)) continue;
        for (const dependency of module.dependencies) {
          if (rule.to.test(dependency.resolved)) keys.push(`${importingAreaOf(module.source)} -> ${dependency.resolved}`);
        }
      }
      return [rule.name, sortedUnique(keys)];
    }),
  );

const findingsOf = ({ cyclicEdges, violations }) => [
  ...cyclicEdges.map(({ key, closedBy }) => ({ kind: MODULE_CYCLE, key, closedBy })),
  ...Object.entries(violations).flatMap(([rule, keys]) => keys.map((key) => ({ kind: rule, key }))),
];

const baselineEntriesOf = (baseline) => [
  ...baseline.moduleCycleEdges.map((key) => ({ kind: MODULE_CYCLE, key })),
  ...Object.entries(baseline.violations).flatMap(([rule, keys]) => keys.map((key) => ({ kind: rule, key }))),
];

const identity = ({ kind, key }) => `${kind}|${key}`;

export const evaluateArchitectureRatchet = ({ cyclicEdges, violations, baseline }) => {
  const recorded = new Set(baselineEntriesOf(baseline).map(identity));
  const findings = findingsOf({ cyclicEdges, violations });
  const found = new Set(findings.map(identity));
  return {
    added: findings.filter((finding) => !recorded.has(identity(finding))),
    stale: baselineEntriesOf(baseline).filter((entry) => !found.has(identity(entry))),
  };
};

export const updateArchitectureBaseline = ({ cyclicEdges, violations, baseline, allowGrowth }) => {
  const recorded = new Set(baselineEntriesOf(baseline).map(identity));
  const keep = (kind, key) => allowGrowth || recorded.has(identity({ kind, key }));
  const refused = allowGrowth
    ? []
    : findingsOf({ cyclicEdges, violations })
        .filter((finding) => !recorded.has(identity(finding)))
        .map(({ kind, key }) => ({ kind, key }));
  return {
    baseline: {
      moduleCycleEdges: cyclicEdges.map(({ key }) => key).filter((key) => keep(MODULE_CYCLE, key)),
      violations: Object.fromEntries(
        Object.entries(violations).map(([rule, keys]) => [rule, keys.filter((key) => keep(rule, key))]),
      ),
    },
    refused,
  };
};

const BACKEND = fileURLToPath(new URL("..", import.meta.url));
const BASELINE_PATH = join(BACKEND, "scripts/architectureRatchetBaseline.json");
const REMEDY = {
  [MODULE_CYCLE]:
    "invert it: depend on a port the lower-level module owns, or move the shared type into that module's contracts",
  ...Object.fromEntries(DIRECTION_RULES.map((rule) => [rule.name, rule.remedy])),
};

const runDependencyCruiser = () => {
  const args = [
    join(BACKEND, "node_modules/dependency-cruiser/bin/dependency-cruise.mjs"),
    "--config",
    "dependency-cruiser.config.cjs",
    "--output-type",
    "json",
    "src",
  ];
  try {
    return execFileSync(process.execPath, args, { cwd: BACKEND, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    // Boundary violations exit non-zero; `lint:boundaries` reports those, this only needs the graph.
    if (typeof error.stdout === "string" && error.stdout.trim().startsWith("{")) return error.stdout;
    throw error;
  }
};

const describeFinding = ({ kind, key, closedBy }) =>
  kind === MODULE_CYCLE ? `${key}  (closed by ${closedBy.join(" -> ")})` : `${kind}: ${key}`;

const run = () => {
  const args = process.argv.slice(2);
  const cruiseResult = JSON.parse(runDependencyCruiser());
  const current = {
    cyclicEdges: findCyclicModuleEdges(moduleEdgesFrom(cruiseResult)),
    violations: directionViolationsFrom(cruiseResult),
  };
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

  if (args.includes("--update")) {
    const updated = updateArchitectureBaseline({ ...current, baseline, allowGrowth: args.includes("--allow-growth") });
    writeFileSync(BASELINE_PATH, `${JSON.stringify(updated.baseline, null, 2)}\n`);
    const before = baselineEntriesOf(baseline).length;
    const after = baselineEntriesOf(updated.baseline).length;
    console.log(`Recorded ${after} architecture ratchet entries (was ${before}).`);
    if (updated.refused.length > 0) {
      console.error(`✖ Refused to record ${updated.refused.length} new entries; fix them, or pass --allow-growth:`);
      for (const entry of updated.refused) console.error(`  ${entry.kind}: ${entry.key}`);
      process.exitCode = 1;
    }
    return;
  }

  const { added, stale } = evaluateArchitectureRatchet({ ...current, baseline });
  if (added.length === 0 && stale.length === 0) {
    const counts = baselineEntriesOf(baseline).length;
    console.log(`✔ architecture ratchet: no new module cycles or direction violations (${counts} baselined)`);
    return;
  }
  for (const kind of [MODULE_CYCLE, ...DIRECTION_RULES.map((rule) => rule.name)]) {
    const found = added.filter((finding) => finding.kind === kind);
    if (found.length === 0) continue;
    console.error(kind === MODULE_CYCLE ? "✖ New module edges inside an import cycle:" : `✖ New ${kind} imports:`);
    for (const finding of found) console.error(`  ${describeFinding(finding)}`);
    console.error(`  Fix: ${REMEDY[kind]}.`);
  }
  if (stale.length > 0) {
    console.error("✖ Baselined entries that no longer occur; re-record with `pnpm run lint:architecture:baseline`:");
    for (const entry of stale) console.error(`  ${entry.kind}: ${entry.key}`);
  }
  process.exitCode = 1;
};

if (isMainModule(import.meta.url)) run();
