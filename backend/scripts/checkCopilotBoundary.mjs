#!/usr/bin/env node
// Issue #1056: no domain module may import the operator copilot (Ray).
//
// Ray is the broadest-knowledge backend module — it consumes agents, routines, directives, chat,
// documents, settings, quality, eval, account and audience-pulse. Per AGENTS.md, broad-knowledge
// modules depend on narrow ones and never the reverse, so nothing under src/modules/* may point
// back at it. Application composition, HTTP, server wiring and repository adapters still may.
//
// This complements the `no-domain-module-imports-operator-copilot` dependency-cruiser rule rather
// than duplicating it. dependency-cruiser runs with `tsPreCompilationDeps` disabled, so it only
// sees imports that survive compilation — a `import type { CopilotToolShape }` back-reference is
// invisible to it. Type-only imports are the *most likely* accidental violation here, because the
// tempting thing to borrow from Ray is a type. Enabling tsPreCompilationDeps globally would be the
// tidier fix, but it currently surfaces 35 unrelated pre-existing violations across eval, chat and
// the engine-concrete boundaries; that is its own cleanup, tracked separately.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const COPILOT_MODULE = "operatorCopilot";
const RAY_KNOWLEDGE_PATTERN = /\b(?:AgentTurnTest|OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL|copilotConversationId|operatorUserId|probeUserMessageId)\b/;

// Matches static imports, type imports, re-exports, and dynamic import() specifiers.
const SPECIFIER_PATTERN = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;

const collectTypeScriptFiles = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectTypeScriptFiles(full, acc);
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
  return acc;
};

export const findCopilotBoundaryViolations = (modulesDir) => {
  const violations = [];
  for (const name of readdirSync(modulesDir)) {
    if (name === COPILOT_MODULE) continue;
    const moduleDir = join(modulesDir, name);
    if (!statSync(moduleDir).isDirectory()) continue;

    for (const file of collectTypeScriptFiles(moduleDir)) {
      const source = readFileSync(file, "utf8");
      for (const [, specifier] of source.matchAll(SPECIFIER_PATTERN)) {
        if (specifier.includes(COPILOT_MODULE)) {
          violations.push(`${relative(modulesDir, file)} → ${specifier}`);
        }
      }
    }
  }
  return violations;
};

export const findChatRayKnowledgeViolations = (modulesDir) => {
  const chatDir = join(modulesDir, "chat");
  return collectTypeScriptFiles(chatDir).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return RAY_KNOWLEDGE_PATTERN.test(source)
      ? [`${relative(modulesDir, file)} contains Ray/operator-copilot knowledge`]
      : [];
  });
};

// CLI entry (skipped when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const modulesDir = fileURLToPath(new URL("../src/modules", import.meta.url));
  const offenders = [
    ...findCopilotBoundaryViolations(modulesDir),
    ...findChatRayKnowledgeViolations(modulesDir),
  ];
  if (offenders.length > 0) {
    console.error("✖ Domain modules must not import the operator copilot (#1056):");
    for (const o of offenders) console.error("  " + o);
    console.error(
      `\n${offenders.length} violation(s). Ray consumes domain modules, never the reverse. If a domain module needs something Ray declares, move it to shared/domain or have composition pass it in.`,
    );
    process.exit(1);
  }
  console.log("✔ no domain module imports the operator copilot");
}
