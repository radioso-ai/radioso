import {
  readProseTerminals,
  routineToChipDoc,
  serializeProseDoc,
  type ParseDiagnostic,
  type ProseParagraph,
} from "@radioso/routine-document";

import type { RoutineDefinition } from "./domain.js";

// The routine text projection the operator copilot reads. One direction only: a routine
// becomes readable text. Nothing parses that text back, so the grammar version records what
// the serializer wrote rather than a contract a caller negotiates.
export const PORTABLE_GRAMMAR_VERSION = 1;

export interface PortableRoutineDocumentEnvelope {
  grammarVersion: number;
  content: string;
}

export type PortableRoutineDocumentProjectionResult =
  | { ok: true; envelope: PortableRoutineDocumentEnvelope }
  | { ok: false; diagnostics: ParseDiagnostic[] };

const unsupportedEnvelopeVersion = (version: number): ParseDiagnostic => ({
  line: 1,
  code: "unsupported_grammar_version",
  message: `Unsupported routine grammar version: ${version}`,
});

const routineNotPortable = (message: string): ParseDiagnostic => ({
  line: 1,
  code: "routine_not_portable",
  message,
});

const routineNotPortableDiagnostic = (routine: RoutineDefinition): ParseDiagnostic => {
  if (routine.activation.gateRef) {
    return routineNotPortable(`Routine portable markdown v1 cannot represent activation gate ${routine.activation.gateRef}.`);
  }

  const handoffTerminals = (routine.terminals ?? []).filter((terminal) => terminal.kind === "handoff");
  if (handoffTerminals.length > 1) {
    return routineNotPortable("Routine portable markdown v1 can represent at most one handoff terminal.");
  }

  return routineNotPortable(
    "Routine portable markdown v1 cannot represent this routine shape. Use the structured routine API or form editor.",
  );
};

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

export const projectRoutineToPortableDocument = (routine: RoutineDefinition): PortableRoutineDocumentProjectionResult => {
  const doc = routineToChipDoc(routine);
  if (!doc) {
    return { ok: false, diagnostics: [routineNotPortableDiagnostic(routine)] };
  }

  return {
    ok: true,
    envelope: {
      grammarVersion: PORTABLE_GRAMMAR_VERSION,
      content: serializeProseDoc({
        name: routine.name,
        trigger: routine.activation.triggerDescription,
        reentryMode: routine.activation.reentryMode,
        priority: routine.activation.priority,
        completionExport: routine.completionExport,
        terminals: readProseTerminals(routine),
        variables: doc.variables,
        paragraphs: doc.paragraphs,
      }),
    },
  };
};

export const routineToPortableDocument = (routine: RoutineDefinition): PortableRoutineDocumentEnvelope => {
  const result = projectRoutineToPortableDocument(routine);
  if (!result.ok) {
    throw new Error(result.diagnostics[0]?.message ?? "Routine definition cannot be represented as portable markdown");
  }
  return result.envelope;
};

