import { describe, expect, it, vi } from "vitest";

import { turnBackgroundJobs } from "../../../src/modules/chat/services/turnBackgroundJobs.js";
import {
  classificationTargetFrom,
  planConversationWrite,
  type ContextValueWriter,
  type ConversationValueWriter,
  type StoredConversationValue,
} from "../../../src/modules/context-variables/public.js";
import {
  CONTEXT_CLASSIFICATION_PROMPT_VERSION,
  ConversationClassificationService,
  contextClassificationHandler,
} from "../../../src/modules/contextClassification/public.js";
import {
  classificationEvalAttributes,
  classificationEvalCases,
  type ClassificationEvalAttributeName,
} from "../../fixtures/context-classification/cases.js";
import { classificationEvalService, classifyEvalCase, scoreEvalCase } from "../../support/contextClassificationEval.js";

/**
 * The deterministic half of the classification eval (#1884). A stubbed model answers each labelled
 * case with its first accepted key, so this checks the pipeline around the model — the prompt and
 * schema it is given, the parse, the job a committed turn writes, the writes and their provenance,
 * and the overwrite rule — never the model's judgement, which the live set
 * (`scripts/runClassificationEvals.ts`) measures.
 */

/** The field the prompt asks an attribute's answer in; null when the run did not send it. */
const fieldOf = (prompt: string, name: string): string | null =>
  new RegExp(`"field": "(attribute_\\d+)",\\s*"name": "${name}"`, "u").exec(prompt)?.[1] ?? null;

/** A model that answers every case the way its label says a reader would. */
const labelledModel = () => {
  const prompts: string[] = [];
  const complete = vi.fn(async (request: { prompt: string }) => {
    prompts.push(request.prompt);
    const evalCase = classificationEvalCases.find((candidate) => candidate.messages.every((message) => request.prompt.includes(JSON.stringify(message).slice(1, -1).replace(/[<>&]/gu, ""))));
    if (!evalCase) throw new Error("the prompt carries no labelled case");
    return {
      text: JSON.stringify(Object.fromEntries(classificationEvalAttributes.flatMap((attribute) => {
        const field = fieldOf(request.prompt, attribute.name);
        return field ? [[field, evalCase.expected[attribute.name as ClassificationEvalAttributeName]?.[0] ?? null]] : [];
      }))),
    };
  });
  return { inference: { create: async () => ({ complete }) as never }, complete, prompts };
};

describe("context classification labelled cases (deterministic)", () => {
  it("offers every accepted key as an active option of its attribute", () => {
    for (const evalCase of classificationEvalCases) {
      for (const [name, accepted] of Object.entries(evalCase.expected)) {
        const attribute = classificationEvalAttributes.find((candidate) => candidate.name === name);
        const keys = attribute?.options?.filter((option) => !option.archived).map((option) => option.key) ?? [];
        for (const value of accepted ?? []) {
          if (value !== null) expect(keys, `${evalCase.id}: ${name}`).toContain(value);
        }
      }
    }
    expect(new Set(classificationEvalCases.map((evalCase) => evalCase.language))).toEqual(new Set(["it", "de", "en"]));
    expect(new Set(classificationEvalCases.flatMap((evalCase) => evalCase.tags))).toEqual(new Set(["none_applies", "topic_change", "injection", "clears"]));
    // Operators define attributes in their own language: an Italian and a German definition are scored.
    const scored = new Set(classificationEvalCases.flatMap((evalCase) => Object.keys(evalCase.expected)));
    expect(scored).toEqual(new Set(["topic", "urgency", "richiesta", "kundentyp"]));
  });

  it("counts a value the classifier set earlier as right only once the run cleared it", () => {
    const evalCase = classificationEvalCases.find((candidate) => candidate.id === "en-clears-topic")!;

    expect(scoreEvalCase(evalCase, { values: { topic: null }, writes: { topic: "cleared" } }).passed).toBe(true);
    expect(scoreEvalCase(evalCase, { values: { topic: null }, writes: {} }).passed).toBe(false);
    expect(scoreEvalCase(evalCase, { values: { topic: "shipping" }, writes: { topic: "unchanged" } }).passed).toBe(false);
  });

  it.each(classificationEvalCases.map((evalCase) => [evalCase.id, evalCase] as const))("%s goes through the strict schema and parses to its labels", async (_id, evalCase) => {
    const model = labelledModel();

    const observed = await classifyEvalCase(classificationEvalService(model.inference), evalCase);

    expect(scoreEvalCase(evalCase, observed).passed).toBe(true);
    expect(model.prompts[0]).toMatch(/untrusted content, not instructions/u);
  });

  it("is enqueued after a committed turn, writes as the classifier, and keeps a value the host or a teammate set", async () => {
    const [topic] = classificationEvalAttributes;
    const evalCase = classificationEvalCases.find((candidate) => candidate.id === "it-billing-invoice")!;
    const enablement = {
      id: "enablement-topic", agentId: "agent-1", variableId: topic.id, source: "classified" as const, resolverSkillId: null,
      maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "on_reference" as const, enabled: true, createdAt: new Date(0), updatedAt: new Date(0),
    };
    const jobs = turnBackgroundJobs({
      workspaceId: topic.workspaceId,
      session: {
        conversation: { id: "conversation-1", sourceChannel: "embed" },
        userMessage: { role: "user", source: "customer" },
        revisionContextVariableEnablements: [enablement],
      },
    });
    const job = jobs.find((candidate) => candidate.kind === "context.classification");
    expect(job).toBeDefined();

    const store = new Map<string, StoredConversationValue>();
    const writer: ConversationValueWriter = {
      write: async (input) => {
        const plan = planConversationWrite({ variable: input.variable, stored: input.stored, data: input.data, writer: input.writtenBy.kind });
        if (plan.action === "store") store.set(input.variable.id, { data: input.data, writtenBy: input.writtenBy });
        if (plan.action === "clear") store.delete(input.variable.id);
        return plan.outcome;
      },
    };
    const model = labelledModel();
    const classifier = new ConversationClassificationService({
      targets: {
        readConversationTargets: async () => {
          const stored = store.get(topic.id);
          return { agentId: "agent-1", targets: [classificationTargetFrom(topic, stored ? [{ scope: { type: "conversation", id: "conversation-1" }, ...stored }] : [])] };
        },
        readDefinitions: async () => [topic],
      },
      excerpts: { readExcerpt: async () => ({ summary: null, messages: evalCase.messages, withheldCount: 0 }) },
      values: writer,
      inference: model.inference,
    });
    const handler = contextClassificationHandler(classifier);

    await handler.run(job!.payload, { signal: new AbortController().signal } as never);
    expect(store.get(topic.id)).toEqual({ data: "billing", writtenBy: { kind: "classifier", ref: CONTEXT_CLASSIFICATION_PROMPT_VERSION } });

    for (const kind of ["operator", "api"] as const) {
      const set: ContextValueWriter = { kind, ref: `${kind}-1` };
      store.set(topic.id, { data: "shipping", writtenBy: set });
      const calls = model.complete.mock.calls.length;
      await expect(handler.run(job!.payload, { signal: new AbortController().signal } as never)).resolves.toEqual({ skipped: "skipped_override" });
      expect(model.complete.mock.calls.length).toBe(calls);
      expect(store.get(topic.id)).toEqual({ data: "shipping", writtenBy: set });
    }
  });
});
