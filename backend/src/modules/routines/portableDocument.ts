import {
  GRAMMAR_VERSION,
  canonicalize,
  draftFromChipDoc,
  parse,
  routineToChipDoc,
  serializeProseDoc,
  type ParseDiagnostic,
  type ProseParagraph,
} from "@radioso/routine-markdown";

import type { RoutineDefinition, RoutineDefinitionDraftInput } from "./domain.js";

export interface PortableRoutineDocumentEnvelope {
  grammarVersion: number;
  content: string;
}

export type PortableRoutineDocumentParseResult =
  | { ok: true; draft: RoutineDefinitionDraftInput }
  | { ok: false; diagnostics: ParseDiagnostic[] };

export type PortableRoutineDocumentCanonicalizeResult =
  | { ok: true; envelope: PortableRoutineDocumentEnvelope }
  | { ok: false; diagnostics: ParseDiagnostic[] };

const unsupportedEnvelopeVersion = (version: number): ParseDiagnostic => ({
  line: 1,
  code: "unsupported_grammar_version",
  message: `Unsupported routine grammar version: ${version}`,
});

const paragraphText = (paragraph: ProseParagraph): string =>
  paragraph.segments.map((segment) => {
    if (segment.kind === "text") {
      return segment.text;
    }
    return segment.chipKind === "variable" ? `{{slot.${segment.refId}}}` : "";
  }).join("");

const paragraphChips = (paragraph: ProseParagraph) =>
  paragraph.segments
    .filter((segment): segment is Extract<ProseParagraph["segments"][number], { kind: "chip" }> =>
      segment.kind === "chip" && segment.chipKind !== "variable"
    )
    .map((segment) => ({
      kind: segment.chipKind,
      refId: segment.refId,
      label: segment.label,
      ...(segment.op ? { op: segment.op } : {}),
      ...(segment.value !== undefined ? { value: segment.value } : {}),
      ...(segment.values !== undefined ? { values: segment.values } : {}),
      ...(segment.unit !== undefined ? { unit: segment.unit } : {}),
      ...(segment.counterLimit !== undefined ? { counterLimit: segment.counterLimit } : {}),
      ...(segment.inputBindings ? { inputBindings: segment.inputBindings } : {}),
      ...(segment.outputAssignments ? { outputAssignments: segment.outputAssignments } : {}),
      ...(segment.mode ? { mode: segment.mode } : {}),
      ...(segment.captureKey !== undefined ? { captureKey: segment.captureKey } : {}),
      ...(segment.options ? { options: segment.options } : {}),
    }));

const bodyBlocksFromParagraphs = (paragraphs: ProseParagraph[]) =>
  paragraphs.map((paragraph) => ({
    text: paragraphText(paragraph),
    chips: paragraphChips(paragraph),
    ...(paragraph.headingLevel ? { headingLevel: paragraph.headingLevel } : {}),
  }));

export const routineToPortableDocument = (routine: RoutineDefinition): PortableRoutineDocumentEnvelope => {
  const doc = routineToChipDoc({
    ...routine,
    activation: {
      ...routine.activation,
      // gateRef is not encoded in the portable grammar. It is preserved on PUT by merging
      // the parsed document with the existing routine, but it must not make projection fail.
      gateRef: null,
    },
  });
  if (!doc) {
    throw new Error("Routine definition cannot be represented as portable markdown");
  }

  return {
    grammarVersion: GRAMMAR_VERSION,
    content: serializeProseDoc({
      name: routine.name,
      trigger: routine.activation.triggerDescription,
      reentryMode: routine.activation.reentryMode,
      priority: routine.activation.priority,
      variables: doc.variables,
      paragraphs: doc.paragraphs,
    }),
  };
};

export const parsePortableRoutineDocument = (
  envelope: PortableRoutineDocumentEnvelope,
  options: { existingGateRef?: string | null } = {},
): PortableRoutineDocumentParseResult => {
  if (envelope.grammarVersion !== GRAMMAR_VERSION) {
    return { ok: false, diagnostics: [unsupportedEnvelopeVersion(envelope.grammarVersion)] };
  }

  const parsed = parse(envelope.content);
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }

  const draft = draftFromChipDoc({
    name: parsed.doc.name ?? "",
    trigger: parsed.doc.trigger ?? "",
    priority: parsed.doc.priority,
    reentryMode: parsed.doc.reentryMode,
    variables: parsed.doc.variables,
    blocks: bodyBlocksFromParagraphs(parsed.doc.paragraphs),
  });

  return {
    ok: true,
    draft: {
      ...draft,
      activation: {
        ...draft.activation,
        gateRef: options.existingGateRef ?? null,
      },
    },
  };
};

export const canonicalizePortableRoutineDocument = (
  envelope: PortableRoutineDocumentEnvelope,
): PortableRoutineDocumentCanonicalizeResult => {
  if (envelope.grammarVersion !== GRAMMAR_VERSION) {
    return { ok: false, diagnostics: [unsupportedEnvelopeVersion(envelope.grammarVersion)] };
  }
  const result = canonicalize(envelope.content);
  if (!result.ok) {
    return { ok: false, diagnostics: result.diagnostics };
  }
  return {
    ok: true,
    envelope: {
      grammarVersion: result.grammarVersion,
      content: result.content,
    },
  };
};
