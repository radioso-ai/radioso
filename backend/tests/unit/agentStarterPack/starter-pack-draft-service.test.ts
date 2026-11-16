import { describe, expect, it, vi } from "vitest";

import {
  StarterPackDraftGenerator,
  StarterPackDraftService,
  type StarterPackDraftServiceOptions,
} from "../../../src/modules/agentStarterPack/public.js";
import { AppError, notFound } from "../../../src/shared/domain/errors.js";
import { ProviderConfigurationError } from "../../../src/shared/infra/llm/providerTypes.js";
import type { ModelInferencePipeline } from "../../../src/shared/infra/llm/modelInferencePipeline.js";
import { LlmResponseLanguageDetector } from "../../../src/shared/services/responseLanguageDetector.js";

const workspaceId = "workspace-1";
const agentId = "22222222-2222-4222-8222-222222222222";

const englishPack = {
  directives: [
    {
      name: "confirm-appointment-details",
      condition: { kind: "contextual", description: "The visitor is booking an appointment." },
      action: "Repeat the date and time back and ask the visitor to confirm.",
    },
    {
      name: "no-medical-diagnosis",
      condition: { kind: "always" },
      action: "Do not diagnose symptoms; offer to book an appointment instead.",
    },
  ],
  routine: {
    name: "book-appointment",
    procedure: "Ask for the treatment, then the preferred date and time, then the visitor's name. Confirm and book.",
  },
};

const germanPack = {
  directives: [
    {
      name: "termindetails-bestaetigen",
      condition: { kind: "always" },
      action: "Wiederhole Datum und Uhrzeit und bitte um Bestätigung.",
    },
  ],
  routine: {
    name: "termin-buchen",
    procedure: "Frage nach Behandlung, Wunschtermin und Name. Bestätige und buche den Termin.",
  },
};

const routineDefinition = (name: string) => ({
  name,
  activation: { triggerDescription: "The visitor wants an appointment.", priority: 50 },
  steps: [],
});

type DraftModelRequest = { prompt: string; operation: { attemptKey: string } };

const setup = (input: {
  detectorAnswer?: string;
  draftAnswers?: Array<string | Error>;
  agentExists?: boolean;
  readiness?: () => Promise<void>;
  routineDraft?: () => Promise<unknown>;
  existingDirectiveNames?: string[];
  existingRoutineNames?: string[];
} = {}) => {
  const detectorComplete = vi.fn(async () => ({ text: input.detectorAnswer ?? '{"responseLanguage":"English"}' }));
  const answers = [...(input.draftAnswers ?? [JSON.stringify(englishPack)])];
  const textGenerationClient = {
    complete: vi.fn(async (_request: DraftModelRequest) => {
      const next = answers.shift() ?? "";
      if (next instanceof Error) throw next;
      return next;
    }),
  };

  // Write-capable methods sit on the same objects as the read ports, so a test can prove the
  // draft path never reaches them.
  const writers = {
    createDirective: vi.fn(),
    updateDirective: vi.fn(),
    createRoutine: vi.fn(),
    updateRoutine: vi.fn(),
    publish: vi.fn(),
  };
  const routineDrafter = {
    draft: vi.fn(input.routineDraft ?? (async (_ws: string, _agent: string, request: { prose: string }) => ({
      draft: routineDefinition(request.prose.startsWith("Frage") ? "termin-buchen-entwurf" : "assist-chosen-name"),
      validation: { diagnostics: [] },
    }))),
  };
  const options: StarterPackDraftServiceOptions = {
    agents: {
      findByIdAndWorkspaceId: vi.fn(async () => input.agentExists === false
        ? null
        : { id: agentId, name: "Front desk", customInstruction: null, greetingInstruction: null }),
    },
    directives: {
      list: vi.fn(async () => (input.existingDirectiveNames ?? []).map((name) => ({ name }))),
      create: writers.createDirective,
      update: writers.updateDirective,
    } as unknown as StarterPackDraftServiceOptions["directives"],
    routines: {
      list: vi.fn(async () => (input.existingRoutineNames ?? []).map((name) => ({ name }))),
      createDraft: writers.createRoutine,
      updateDraft: writers.updateRoutine,
    } as unknown as StarterPackDraftServiceOptions["routines"],
    routineDrafter: routineDrafter as unknown as StarterPackDraftServiceOptions["routineDrafter"],
    chatReadiness: { assertChatConfigured: vi.fn(input.readiness ?? (async () => undefined)) },
    generator: new StarterPackDraftGenerator({
      textGenerationClient,
      languageDetector: new LlmResponseLanguageDetector({
        metadata: { provider: "test", model: "test-model" },
        complete: detectorComplete,
      } as unknown as ModelInferencePipeline),
      logger: { info: vi.fn(), warn: vi.fn() },
    }),
  };
  return {
    service: new StarterPackDraftService(options),
    options,
    writers,
    routineDrafter,
    textGenerationClient,
    detectorComplete,
  };
};

describe("StarterPackDraftService", () => {
  it("returns suggested directives and exactly one routine as reviewable items", async () => {
    const { service, routineDrafter } = setup();

    const result = await service.draft(workspaceId, agentId, "Help visitors book dental appointments.");

    const directives = result.items.filter((item) => item.kind === "directive");
    const routines = result.items.filter((item) => item.kind === "routine");
    expect(directives.map((item) => item.directive.name)).toEqual([
      "confirm-appointment-details",
      "no-medical-diagnosis",
    ]);
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({
      kind: "routine",
      procedure: englishPack.routine.procedure,
      // The pack's name, which the prompt kept clear of existing names, wins over the assist's.
      routine: { name: "book-appointment" },
      validation: { diagnostics: [] },
      conflict: null,
    });
    expect(new Set(result.items.map((item) => item.itemKey)).size).toBe(result.items.length);
    expect(routineDrafter.draft).toHaveBeenCalledWith(
      workspaceId,
      agentId,
      { prose: englishPack.routine.procedure },
      { outputLanguage: "English" },
    );
    expect(result.outputLanguage).toBe("English");
  });

  it("drafts in the language detected from a non-English purpose", async () => {
    const { service, textGenerationClient, routineDrafter } = setup({
      detectorAnswer: '{"responseLanguage":"German"}',
      draftAnswers: [JSON.stringify(germanPack)],
    });

    const result = await service.draft(workspaceId, agentId, "Hilf Besuchern, Zahnarzttermine zu buchen.");

    expect(result.outputLanguage).toBe("German");
    expect(textGenerationClient.complete.mock.calls[0]?.[0].prompt).toContain("Write every user-facing field in German.");
    // The same detected language drives the one routine's definition, not only the pack prompt.
    expect(routineDrafter.draft).toHaveBeenCalledTimes(1);
    expect(routineDrafter.draft).toHaveBeenCalledWith(
      workspaceId,
      agentId,
      { prose: germanPack.routine.procedure },
      { outputLanguage: "German" },
    );
    const routines = result.items.filter((item) => item.kind === "routine");
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({ routine: { name: "termin-buchen" }, procedure: germanPack.routine.procedure });
  });

  it("lets the routine mirror the procedure's language when detection gives no usable answer", async () => {
    const { service, routineDrafter } = setup({
      detectorAnswer: "not json",
      draftAnswers: [JSON.stringify(germanPack)],
    });

    const result = await service.draft(workspaceId, agentId, "Hilf Besuchern, Zahnarzttermine zu buchen.");

    expect(result.outputLanguage).toBeNull();
    expect(routineDrafter.draft).toHaveBeenCalledWith(workspaceId, agentId, { prose: germanPack.routine.procedure }, {});
    expect(result.items.filter((item) => item.kind === "routine")).toHaveLength(1);
  });

  it("flags suggestions whose names are already used on the agent, without changing them", async () => {
    const { service } = setup({
      existingDirectiveNames: ["no-medical-diagnosis"],
      existingRoutineNames: ["book-appointment"],
    });

    const result = await service.draft(workspaceId, agentId, "Help visitors book dental appointments.");

    const conflicts = Object.fromEntries(result.items.map((item) => [
      item.kind === "directive" ? item.directive.name : item.routine.name,
      item.conflict,
    ]));
    expect(conflicts).toEqual({
      "confirm-appointment-details": null,
      "no-medical-diagnosis": "name_exists",
      "book-appointment": "name_exists",
    });
  });

  it("never creates, updates, or publishes anything", async () => {
    const { service, writers } = setup();

    await service.draft(workspaceId, agentId, "Help visitors book dental appointments.");

    for (const writer of Object.values(writers)) {
      expect(writer).not.toHaveBeenCalled();
    }
  });

  it("returns 404 for an unknown agent before calling any model", async () => {
    const { service, textGenerationClient, detectorComplete, options } = setup({ agentExists: false });

    await expect(service.draft(workspaceId, agentId, "Help visitors book appointments."))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(options.chatReadiness.assertChatConfigured).not.toHaveBeenCalled();
    expect(detectorComplete).not.toHaveBeenCalled();
    expect(textGenerationClient.complete).not.toHaveBeenCalled();
  });

  it("surfaces a missing LLM configuration as 503 provider_misconfigured before calling any model", async () => {
    const { service, textGenerationClient, detectorComplete } = setup({
      readiness: async () => {
        throw new ProviderConfigurationError("No chat model is configured.", { kind: "missing_api_key", capability: "chat" });
      },
    });

    await expect(service.draft(workspaceId, agentId, "Help visitors book appointments."))
      .rejects.toMatchObject({ statusCode: 503, code: "provider_misconfigured" });
    expect(detectorComplete).not.toHaveBeenCalled();
    expect(textGenerationClient.complete).not.toHaveBeenCalled();
  });

  it("maps a provider failure during drafting to 503 llm_unavailable", async () => {
    const { service } = setup({ draftAnswers: [new Error("socket hang up")] });

    const result = service.draft(workspaceId, agentId, "Help visitors book appointments.");

    await expect(result).rejects.toBeInstanceOf(AppError);
    await expect(result).rejects.toMatchObject({ statusCode: 503, code: "llm_unavailable" });
  });

  it("maps a provider failure while drafting the routine to 503 llm_unavailable", async () => {
    const { service } = setup({ routineDraft: async () => { throw new Error("timeout"); } });

    await expect(service.draft(workspaceId, agentId, "Help visitors book appointments."))
      .rejects.toMatchObject({ statusCode: 503, code: "llm_unavailable" });
  });

  it("keeps the 422 when the model never returns a valid pack", async () => {
    const { service } = setup({ draftAnswers: ["nope", "still nope"] });

    await expect(service.draft(workspaceId, agentId, "Help visitors book appointments."))
      .rejects.toMatchObject({ statusCode: 422, code: "invalid_starter_pack_draft" });
  });

  it("keeps an AppError from the routine drafter as is", async () => {
    const { service } = setup({
      routineDraft: async () => { throw new AppError(422, "invalid_routine_draft_assist", "bad routine"); },
    });

    await expect(service.draft(workspaceId, agentId, "Help visitors book appointments."))
      .rejects.toMatchObject({ statusCode: 422, code: "invalid_routine_draft_assist" });
  });

  it("does not swallow a not-found raised while reading names", async () => {
    const { service, options } = setup();
    vi.mocked(options.directives.list).mockRejectedValueOnce(notFound("Agent not found"));

    await expect(service.draft(workspaceId, agentId, "Help visitors book appointments."))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
