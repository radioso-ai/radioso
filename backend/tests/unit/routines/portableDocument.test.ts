import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { GRAMMAR_VERSION } from "@radioso/routine-markdown";

import {
  canonicalizePortableRoutineDocument,
  parsePortableRoutineDocument,
  projectRoutineToPortableDocument,
  routineToPortableDocument,
} from "../../../src/modules/routines/portableDocument.js";
import type { RoutineDefinition } from "../../../src/modules/routines/public.js";

const routine = (overrides: Partial<RoutineDefinition> = {}): RoutineDefinition => ({
  id: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  lineageId: "33333333-3333-4333-8333-333333333333",
  version: 1,
  status: "draft",
  name: "support-intake",
  activation: {
    triggerDescription: "When the user needs support",
    gateRef: "existing-gate",
    priority: 7,
    reentryMode: "always",
  },
  slots: [{
    stableSlotId: "slot_topic",
    key: "topic",
    type: "text",
    required: true,
    description: "topic",
    ordinal: 0,
  }],
  steps: [{
    stableStepId: "collect_topic",
    kind: "chat",
    instruction: "Ask for {{slot.topic}}.",
    toolRef: null,
    actionType: null,
    ordinal: 0,
    metadata: { outlineLabel: "collect_topic" },
  }],
  transitions: [{
    fromStep: "collect_topic",
    toRef: "done",
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: "done",
    kind: "complete",
    instruction: null,
    ordinal: 0,
  }],
  createdAt: new Date("2026-07-13T10:00:00.000Z"),
  updatedAt: new Date("2026-07-13T10:00:00.000Z"),
  ...overrides,
});

describe("portable routine document mapper", () => {
  it("projects a definition to a canonical versioned markdown envelope", () => {
    const envelope = routineToPortableDocument(routine());

    expect(envelope).toEqual({
      grammarVersion: GRAMMAR_VERSION,
      content: [
        "---",
        `grammar: ${GRAMMAR_VERSION}`,
        "name: support-intake",
        "trigger: When the user needs support",
        "reentry: always",
        "priority: 7",
        "---",
        "# collect_topic",
        "Ask for @topic.",
      ].join("\n") + "\n",
    });
  });

  it("returns a typed diagnostic when a valid routine is not portable markdown representable", () => {
    const projected = projectRoutineToPortableDocument(routine({
      transitions: [
        {
          fromStep: "collect_topic",
          toRef: "handoff_sales",
          guardKind: "default",
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          ordinal: 0,
        },
      ],
      terminals: [
        {
          stableStepId: "done",
          kind: "complete",
          instruction: null,
          ordinal: 0,
        },
        {
          stableStepId: "handoff_sales",
          kind: "handoff",
          instruction: null,
          ordinal: 1,
        },
        {
          stableStepId: "handoff_support",
          kind: "handoff",
          instruction: null,
          ordinal: 2,
        },
      ],
    }));

    expect(projected).toEqual({
      ok: false,
      diagnostics: [{
        line: 1,
        code: "routine_not_portable",
        message: "Routine portable markdown v1 can represent at most one handoff terminal.",
      }],
    });
  });

  it("treats field guards with missing required operands as unrepresentable", () => {
    const projected = projectRoutineToPortableDocument(routine({
      activation: {
        triggerDescription: "When the user needs support",
        gateRef: null,
        priority: 7,
        reentryMode: "always",
      },
      slots: [
        {
          stableSlotId: "slot_topic",
          key: "topic",
          type: "text",
          required: true,
          description: "topic",
          ordinal: 0,
        },
        {
          stableSlotId: "slot_amount",
          key: "amount",
          type: "number",
          required: true,
          description: "amount",
          ordinal: 1,
        },
      ],
      transitions: [
        {
          fromStep: "collect_topic",
          toRef: "done",
          guardKind: "field",
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          fieldRef: "amount",
          fieldOp: "equals",
          fieldValue: null,
          fieldValues: null,
          fieldUnit: null,
          ordinal: 0,
        },
        {
          fromStep: "collect_topic",
          toRef: "done",
          guardKind: "default",
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          ordinal: 1,
        },
      ],
    }));

    expect(projected).toEqual({
      ok: false,
      diagnostics: [{
        line: 1,
        code: "routine_not_portable",
        message: "Routine portable markdown v1 cannot represent this routine shape. Use the structured routine API or form editor.",
      }],
    });
  });

  it("projects field guards with complete operands to markdown that re-parses", () => {
    const projected = projectRoutineToPortableDocument(routine({
      activation: {
        triggerDescription: "When the user needs support",
        gateRef: null,
        priority: 7,
        reentryMode: "always",
      },
      transitions: [
        {
          fromStep: "collect_topic",
          toRef: "done",
          guardKind: "field",
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          fieldRef: "topic",
          fieldOp: "equals",
          fieldValue: "billing",
          fieldValues: null,
          fieldUnit: null,
          ordinal: 0,
        },
        {
          fromStep: "collect_topic",
          toRef: "done",
          guardKind: "default",
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          ordinal: 1,
        },
      ],
    }));

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(parsePortableRoutineDocument(projected.envelope)).toMatchObject({ ok: true });
  });

  it("parses markdown into draft authoring input and preserves an existing gate on update", () => {
    const parsed = parsePortableRoutineDocument({
      grammarVersion: GRAMMAR_VERSION,
      content: [
        "---",
        `grammar: ${GRAMMAR_VERSION}`,
        "name: support-intake",
        "trigger: When the user needs support",
        "reentry: semantic",
        "priority: 4",
        "---",
        "# collect_topic",
        "Ask for @topic.",
      ].join("\n"),
    }, { existingGateRef: "gate-kept" });

    expect(parsed).toMatchObject({
      ok: true,
      draft: {
        name: "support-intake",
        activation: {
          triggerDescription: "When the user needs support",
          gateRef: "gate-kept",
          priority: 4,
          reentryMode: "semantic",
        },
        slots: [{ key: "topic" }],
        steps: [{ stableStepId: "collect_topic" }],
      },
    });
  });

  it("maps grammar errors to 400-shaped diagnostics without a partial draft", () => {
    const parsed = parsePortableRoutineDocument({
      grammarVersion: GRAMMAR_VERSION,
      content: "---\ngrammar: 1\nname: bad\ntrigger: bad\nreentry: later\n---\nAsk @topic.",
    });

    expect(parsed).toEqual({
      ok: false,
      diagnostics: [{
        line: 5,
        code: "invalid_reentry",
        message: "Unsupported routine reentry mode: later",
      }],
    });
  });

  it("canonicalizes without persistence state", () => {
    const canonical = canonicalizePortableRoutineDocument({
      grammarVersion: GRAMMAR_VERSION,
      content: "---\nname: Greeter\ntrigger: hi\n---\nAsk @email.",
    });

    expect(canonical).toEqual({
      ok: true,
      envelope: {
        grammarVersion: GRAMMAR_VERSION,
        content: "---\ngrammar: 1\nname: Greeter\ntrigger: hi\n---\nAsk @email.\n",
      },
    });
  });

  it("has no transport, Express, or model-provider dependencies", () => {
    const sourcePath = join(process.cwd(), "src/modules/routines/portableDocument.ts");
    const source = ts.createSourceFile(
      sourcePath,
      readFileSync(sourcePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const imports = source.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => statement.moduleSpecifier)
      .filter(ts.isStringLiteral)
      .map((specifier) => specifier.text);

    expect(imports).toEqual(expect.arrayContaining([
      "@radioso/routine-markdown",
      "./domain.js",
    ]));
    expect(imports).not.toEqual(expect.arrayContaining([
      "express",
      "../../../shared/infra/llm/modelGateway.js",
      "../../shared/infra/llm/modelGateway.js",
    ]));
    expect(imports.some((specifier) => specifier.includes("/llm/") || specifier.includes("modelGateway"))).toBe(false);
  });
});
