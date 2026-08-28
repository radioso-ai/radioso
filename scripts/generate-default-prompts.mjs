#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(
  repoRoot,
  "packages",
  "conversation-defaults",
  "src",
  "generated",
  "defaultPrompts.ts",
);

const manifest = [
  {
    source: "routine-step-reply.md",
    exportName: "DEFAULT_ROUTINE_STEP_REPLY_PROMPT",
  },
  {
    source: "routine-step-terminal-handoff-with-message.md",
    exportName: "DEFAULT_ROUTINE_STEP_TERMINAL_HANDOFF_WITH_MESSAGE_PROMPT",
  },
  {
    source: "routine-step-terminal-handoff-default.md",
    exportName: "DEFAULT_ROUTINE_STEP_TERMINAL_HANDOFF_DEFAULT_PROMPT",
  },
  {
    source: "routine-next-step.md",
    exportName: "DEFAULT_ROUTINE_NEXT_STEP_PROMPT",
  },
  {
    source: "directive-match.md",
    exportName: "DEFAULT_DIRECTIVE_MATCH_SYSTEM_PROMPT",
  },
  {
    source: "routine-slot-correction-detect.md",
    exportName: "DEFAULT_ROUTINE_SLOT_CORRECTION_DETECT_PROMPT",
  },
  {
    source: "routine-slot-correction-confirm.md",
    exportName: "DEFAULT_ROUTINE_SLOT_CORRECTION_CONFIRM_PROMPT",
  },
  {
    source: "routine-slot-correction-invalid.md",
    exportName: "DEFAULT_ROUTINE_SLOT_CORRECTION_INVALID_PROMPT",
  },
  {
    source: "routine-reentry-gate.md",
    exportName: "DEFAULT_ROUTINE_REENTRY_GATE_PROMPT",
  },
  {
    source: "steering.md",
    exportName: "DEFAULT_STEERING_PROMPT",
  },
  {
    source: "steering-clarification.md",
    exportName: "DEFAULT_CLARIFICATION_STEERING_PROMPT",
  },
];

const escapeTemplateLiteral = (value) =>
  value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");

const readPrompt = (source) =>
  readFileSync(path.join(repoRoot, "backend", "prompts", "chat", source), "utf8").trimEnd();

const renderGeneratedFile = () => {
  const exports = manifest.map(({ source, exportName }) => {
    const prompt = escapeTemplateLiteral(readPrompt(source));
    return `export const ${exportName} = \`${prompt}\`;\n`;
  });

  return [
    "// GENERATED - do not edit; run `pnpm run generate:prompts`.",
    "",
    ...exports,
  ].join("\n");
};

const check = process.argv.includes("--check");
const generated = renderGeneratedFile();

if (check) {
  let current = "";
  try {
    current = readFileSync(outputPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Generated default prompt file is missing: ${outputPath}\n${message}`);
    process.exit(1);
  }

  if (current !== generated) {
    console.error(
      `Generated default prompts are stale: ${outputPath}\n` +
        "Run `pnpm run generate:prompts` from the repository root and commit the result.",
    );
    process.exit(1);
  }

  console.log("Generated default prompts are current.");
} else {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, generated);
  console.log(`Wrote ${outputPath}`);
}
