/**
 * Live labelled set for attribute classification (#1884): the classifier's prompt, strict schema and
 * parse, against the workspace-default `rewrite`-tier model, over the conversations in
 * `tests/fixtures/context-classification/cases.ts` (Italian, German and English; cases where no
 * option applies, a topic change, and an instruction injected into the visitor's message).
 *
 *   pnpm run evals:classification                          # one sample per case, gated on the baseline
 *   pnpm run evals:classification -- --samples 3
 *   pnpm run evals:classification:update-baseline          # re-record the baseline
 *
 * A case passes when every attribute it scores holds an accepted answer; accuracy is the share of
 * cases and of scored attributes that do. The run exits non-zero when a case the committed baseline
 * (`tests/fixtures/context-classification/baseline.json`) records as passing no longer does, using
 * the conversation-quality suite's baseline rules. The deterministic half runs in unit CI
 * (`tests/unit/eval-suite/context-classification-cases.test.ts`).
 *
 * REQUIREMENTS: the rewrite-tier provider's credentials (LLM_PROVIDER, OPENAI_API_KEY) and the
 * application env (`node --env-file=./.env.evals`). No database: the attributes are the fixture's.
 * A rewrite model that is not mini-class needs `--allow-model <name>`.
 */
// First: Zod 4 gives `.openapi()` only to schemas built after this runs.
import "../src/app/http/openapi/zodOpenApiExtension.js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getEnv } from "../src/app/config/env.js";
import { buildLlmRegistry } from "../src/app/server/builders/integrations.js";
import {
  buildBaselineFile,
  diffAgainstBaseline,
  hasBaselineGateFailures,
  isBaselineInitialized,
  parseBaselineFile,
  type CaseOutcome,
} from "../src/modules/eval/suite/index.js";
import { createLogger } from "../src/shared/observability/logger.js";
import { classificationEvalCases } from "../tests/fixtures/context-classification/cases.js";
import { classificationEvalService, classifyEvalCase, scoreEvalCase } from "../tests/support/contextClassificationEval.js";

const BASELINE_PATH = fileURLToPath(new URL("../tests/fixtures/context-classification/baseline.json", import.meta.url));
const PASS_THRESHOLD = 0.6;
/** Model names cheap enough to run on demand without `--allow-model`. */
const MINI_CLASS_MODEL = /mini|nano/u;

const flagValue = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
};

const main = async (): Promise<void> => {
  const samples = Number(flagValue("samples") ?? "1");
  if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples takes a positive integer");
  const updateBaseline = process.argv.includes("--update-baseline");

  const logger = createLogger();
  const pipeline = buildLlmRegistry(getEnv(), logger).createRewriteInferencePipeline();
  const { model } = pipeline.metadata;
  if (model !== flagValue("allow-model") && !MINI_CLASS_MODEL.test(model)) {
    throw new Error(`Refusing to run on rewrite model "${model}": live runs use a mini-class model; pass --allow-model ${model} to override.`);
  }
  const classifier = classificationEvalService({ create: async () => pipeline });

  const outcomes: CaseOutcome[] = [];
  let fieldsScored = 0;
  let fieldsCorrect = 0;
  for (const evalCase of classificationEvalCases) {
    let passes = 0;
    let errored = false;
    for (let sample = 0; sample < samples; sample += 1) {
      try {
        const score = scoreEvalCase(evalCase, await classifyEvalCase(classifier, evalCase));
        passes += score.passed ? 1 : 0;
        fieldsScored += score.fields.length;
        fieldsCorrect += score.fields.filter((field) => field.correct).length;
        const misses = score.fields.filter((field) => !field.correct)
          .map((field) => `${field.name}: expected ${JSON.stringify(field.expected)}, got ${JSON.stringify(field.observed)}`);
        process.stderr.write(`${score.passed ? "PASS" : "FAIL"} ${evalCase.id} [${evalCase.language}${evalCase.tags.length ? ` ${evalCase.tags.join(",")}` : ""}]${misses.length ? ` — ${misses.join("; ")}` : ""}\n`);
      } catch (error) {
        errored = true;
        process.stderr.write(`ERROR ${evalCase.id}: ${error instanceof Error ? error.name : "error"}\n`);
      }
    }
    const passRate = passes / samples;
    outcomes.push({
      caseId: evalCase.id,
      name: evalCase.id,
      status: errored && passes === 0 ? "error" : passRate >= PASS_THRESHOLD ? "pass" : "fail",
      passRate,
      samples,
    });
  }

  const casesPassed = outcomes.filter((outcome) => outcome.status === "pass").length;
  process.stderr.write(
    `\nModel ${model}, ${samples} sample(s): ${casesPassed}/${outcomes.length} cases pass; `
    + `${fieldsCorrect}/${fieldsScored} scored attributes right (${fieldsScored ? Math.round((fieldsCorrect / fieldsScored) * 100) : 0}%).\n`,
  );

  if (updateBaseline) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(buildBaselineFile(outcomes, new Date().toISOString(), PASS_THRESHOLD), null, 2)}\n`);
    process.stderr.write(`Recorded ${BASELINE_PATH}\n`);
    return;
  }
  const baseline = parseBaselineFile(JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
  if (!isBaselineInitialized(baseline)) throw new Error("The classification baseline is empty; record it with --update-baseline");
  const diff = diffAgainstBaseline(outcomes, baseline, { passThreshold: PASS_THRESHOLD });
  for (const regression of diff.regressions) process.stderr.write(`REGRESSED ${regression.caseId}: ${regression.from} -> ${regression.to}\n`);
  for (const fix of diff.fixes) process.stderr.write(`FIXED ${fix.caseId}: ${fix.from} -> ${fix.to}\n`);
  if (hasBaselineGateFailures(diff)) process.exitCode = 1;
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
