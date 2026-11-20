/**
 * Starter pack draft-quality eval (#1158). Each case replays recorded model completions through
 * the real draft path: the response-language detector, the pack generator, the routine draft
 * assist, and the draft service. Only the network call to a model is replaced, so the suite is
 * deterministic and belongs in the unit eval suite, like facet-quality, rather than a live one.
 * Every case must pass; there is no baseline because there is no sampling noise to absorb.
 */
import { describe, expect, it, vi } from "vitest";

import { authoredDirectiveInputSchema } from "../../../src/modules/agents/public.js";
import { StarterPackDraftGenerator, StarterPackDraftService } from "../../../src/modules/agentStarterPack/public.js";
import { defaultAnswerDirectives } from "../../../src/modules/directives/public.js";
import { RoutineDraftAssistService } from "../../../src/modules/routines/public.js";
import { renderOutputLanguageInstruction } from "../../../src/shared/domain/outputLanguageInstruction.js";
import type { ModelInferencePipeline } from "../../../src/shared/infra/llm/modelInferencePipeline.js";
import { LlmResponseLanguageDetector } from "../../../src/shared/services/responseLanguageDetector.js";
import {
  parseStarterPackDraftQualityCases,
  starterPackDraftQualityCases,
  type StarterPackDraftQualityCase,
} from "../../fixtures/starter-pack-draft-quality/cases.js";

const workspaceId = "workspace-eval";
const agentId = "22222222-2222-4222-8222-222222222222";
const agent = { id: agentId, name: "Eval agent", customInstruction: null, greetingInstruction: null };
const reservedNames = new Set(defaultAnswerDirectives.map((directive) => directive.name));
const applyableDirective = authoredDirectiveInputSchema.omit({ routes: true });

type PromptCall = { prompt: string };

/** A model client that answers with the case's recorded completions, in order, and records prompts. */
const replay = (outputs: readonly string[]) => {
  const queue = [...outputs];
  const calls: PromptCall[] = [];
  return {
    calls,
    complete: vi.fn(async (request: PromptCall) => {
      calls.push({ prompt: request.prompt });
      return queue.shift() ?? "";
    }),
  };
};

const runCase = async (evalCase: StarterPackDraftQualityCase) => {
  const detectorClient = replay([evalCase.detectorAnswer]);
  const packClient = replay(evalCase.recordedDraftOutputs);
  const routineClient = replay(evalCase.recordedRoutineOutputs);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = new StarterPackDraftService({
    agents: { findByIdAndWorkspaceId: async () => agent },
    directives: { list: async () => (evalCase.existingDirectiveNames ?? []).map((name) => ({ name })) },
    routines: { list: async () => (evalCase.existingRoutineNames ?? []).map((name) => ({ name })) },
    routineDrafter: new RoutineDraftAssistService({
      repository: { findByIdAndWorkspaceId: vi.fn(async () => agent) } as never,
      textGenerationClient: routineClient,
      actionCatalog: [{ type: "contact.send", kind: "action" }],
      logger,
    }),
    chatReadiness: { assertChatConfigured: async () => undefined },
    generator: new StarterPackDraftGenerator({
      textGenerationClient: packClient,
      languageDetector: new LlmResponseLanguageDetector({
        metadata: { provider: "test", model: "recorded" },
        complete: async (request: PromptCall) => ({ text: await detectorClient.complete(request) }),
      } as unknown as ModelInferencePipeline),
      logger,
    }),
  });
  const outcome = await service.draft(workspaceId, agentId, evalCase.purpose).then(
    (response) => ({ response, error: null }),
    (error: unknown) => ({ response: null, error }),
  );
  return { outcome, packClient, routineClient };
};

/** Named quality checks for one case; an empty list means the case passed. */
const scoreCase = async (evalCase: StarterPackDraftQualityCase): Promise<string[]> => {
  const { outcome, packClient, routineClient } = await runCase(evalCase);
  const failures: string[] = [];
  const check = (passed: boolean, name: string) => {
    if (!passed) failures.push(name);
  };

  check(packClient.calls.length === evalCase.recordedDraftOutputs.length, `pack calls: expected ${evalCase.recordedDraftOutputs.length}, got ${packClient.calls.length}`);
  const languageInstruction = renderOutputLanguageInstruction(evalCase.expectedLanguage ?? undefined);
  check(packClient.calls.every((call) => call.prompt.includes(languageInstruction)), "pack prompt carries the expected output language instruction");
  for (const name of [...(evalCase.existingDirectiveNames ?? []), ...(evalCase.existingRoutineNames ?? [])]) {
    check(packClient.calls.every((call) => call.prompt.includes(name)), `pack prompt lists the existing name "${name}"`);
  }

  if (evalCase.expectedOutcome === "invalid_starter_pack_draft") {
    check(outcome.response === null, "an invalid pack is never returned");
    check((outcome.error as { code?: string } | null)?.code === "invalid_starter_pack_draft", "fails with invalid_starter_pack_draft");
    check(routineClient.calls.length === 0, "no routine is drafted from an invalid pack");
    return failures;
  }

  if (!outcome.response) {
    failures.push(`draft failed: ${(outcome.error as Error | null)?.message ?? "unknown error"}`);
    return failures;
  }
  const { response } = outcome;
  const directives = response.items.flatMap((item) => (item.kind === "directive" ? [item] : []));
  const routines = response.items.flatMap((item) => (item.kind === "routine" ? [item] : []));
  const directiveNames = directives.map((item) => item.directive.name);

  check(response.outputLanguage === evalCase.expectedLanguage, `output language: expected ${String(evalCase.expectedLanguage)}, got ${String(response.outputLanguage)}`);
  check(routines.length === 1, `exactly one routine, got ${routines.length}`);
  check(directives.length >= 1 && directives.length <= 6, `1 to 6 directives, got ${directives.length}`);
  check(directiveNames.every((name) => !reservedNames.has(name)), "no reserved built-in directive names");
  check(new Set(directiveNames).size === directiveNames.length, "directive names are unique");
  check(response.items.every((item) => item.conflict === null), "no suggestion reuses a name already on the agent");
  check(directives.every((item) => applyableDirective.safeParse(item.directive).success), "every directive passes the apply contract");
  const routine = routines[0];
  if (routine) {
    check(routine.validation.ok && routine.validation.diagnostics.length === 0, `routine validates: ${routine.validation.diagnostics.map((diagnostic) => diagnostic.code).join(", ")}`);
  }
  const routineInstruction = renderOutputLanguageInstruction(evalCase.expectedLanguage ?? undefined, "the procedure");
  check(routineClient.calls.length > 0 && routineClient.calls.every((call) => call.prompt.includes(routineInstruction)), "routine prompt carries the same output language");
  return failures;
};

describe("starter pack draft-quality dataset", () => {
  it("parses and keeps case ids unique", () => {
    expect(parseStarterPackDraftQualityCases(starterPackDraftQualityCases)).toHaveLength(starterPackDraftQualityCases.length);
  });

  it("covers several languages, the fallback, retries, name handling, and a rejection", () => {
    const tags = new Set(starterPackDraftQualityCases.flatMap((entry) => entry.tags));
    for (const tag of ["english", "german", "japanese", "spanish", "fallback", "retry", "names", "rejection"]) {
      expect(tags, `missing a "${tag}" case`).toContain(tag);
    }
  });
});

describe("starter pack draft-quality scorer", () => {
  const base = starterPackDraftQualityCases.find((entry) => entry.id === "de-dental-booking");
  if (!base) throw new Error("fixture de-dental-booking is missing");

  it("flags a draft written in a different language than detected", async () => {
    const failures = await scoreCase({ ...base, detectorAnswer: '{"responseLanguage":"French"}' });

    expect(failures.some((failure) => failure.startsWith("output language"))).toBe(true);
  });

  it("flags a routine that does not validate", async () => {
    const routine = JSON.parse(base.recordedRoutineOutputs[0] ?? "{}") as { draft: { steps: Array<{ instruction: string }>; terminals: Array<{ instruction: string }> } };
    // Drop every reference to the declared slot, so the validator reports it as unused.
    routine.draft.steps = routine.draft.steps.map((step) => ({ ...step, instruction: "Frage nach dem Termin." }));
    routine.draft.terminals = routine.draft.terminals.map((terminal) => ({ ...terminal, instruction: "Bestätige." }));
    const unusedSlot = JSON.stringify(routine);

    const failures = await scoreCase({ ...base, recordedRoutineOutputs: [unusedSlot, unusedSlot] });

    expect(failures.some((failure) => failure.startsWith("routine validates"))).toBe(true);
  });

  it("flags a suggestion that reuses a name already on the agent", async () => {
    const failures = await scoreCase({ ...base, existingDirectiveNames: ["keine-diagnosen"] });

    expect(failures).toContain("no suggestion reuses a name already on the agent");
  });

  it("flags a draft that should have been rejected", async () => {
    const failures = await scoreCase({ ...base, expectedOutcome: "invalid_starter_pack_draft" });

    expect(failures).toContain("an invalid pack is never returned");
  });
});

describe("starter pack draft quality (deterministic replay)", () => {
  it("passes every quality check on every case", async () => {
    const report: string[] = [];
    for (const evalCase of starterPackDraftQualityCases) {
      const failures = await scoreCase(evalCase);
      if (failures.length > 0) report.push(`${evalCase.id}:\n  - ${failures.join("\n  - ")}`);
    }
    expect(report.join("\n"), "draft-quality failures").toBe("");
  });
});
