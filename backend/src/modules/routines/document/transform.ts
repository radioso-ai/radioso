import type { RoutineValidationDiagnostic } from "../validator.js";
import type { RoutineDefinitionDraftInput } from "../domain.js";
import type {
  DocumentTextRange,
  RoutineDocument,
  RoutineDocumentBranch,
  RoutineDocumentDiagnostic,
  RoutineDocumentDraftResult,
  RoutineDocumentEnd,
  RoutineDocumentRoutineSection,
  RoutineDocumentSourceMap,
  RoutineDocumentStep,
} from "./model.js";

const emptySourceMap = (): RoutineDocumentSourceMap => ({
  stableIds: {},
  slots: {},
  transitions: {},
});

const slotTokenPattern = /\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;
const mentionTokenPattern = /@([A-Za-z_][A-Za-z0-9_.-]*)/gu;
const trailingMentionPunctuationPattern = /[.,;:!?]+$/u;

const splitMentionName = (rawName: string): { name: string; suffix: string } => {
  const name = rawName.replace(trailingMentionPunctuationPattern, "");
  return { name, suffix: rawName.slice(name.length) };
};

export const encodeRoutineDocumentText = (text: string | null | undefined): string =>
  (text ?? "").replace(slotTokenPattern, (_match, key: string) => `@${key}`);

export const decodeRoutineDocumentText = (text: string, slotKeys: ReadonlySet<string>): string =>
  text.replace(mentionTokenPattern, (match: string, rawName: string) => {
    const { name, suffix } = splitMentionName(rawName);
    return slotKeys.has(name) ? `{{slot.${name}}}${suffix}` : match;
  });

const transitionKey = (fromStep: string, toRef: string): string => `${fromStep}->${toRef}`;

export const routineDraftToDocument = (draft: RoutineDefinitionDraftInput): RoutineDocument => {
  const transitionsByStep = new Map<string, RoutineDocumentBranch[]>();
  const terminalIds = new Set(draft.terminals.map((terminal) => terminal.stableStepId));
  const stepIds = new Set(draft.steps.map((step) => step.stableStepId));

  for (const transition of [...draft.transitions].sort((left, right) => left.ordinal - right.ordinal)) {
    const guard: RoutineDocumentBranch["guard"] =
      transition.guardKind === "llm"
        ? { kind: "llm", text: encodeRoutineDocumentText(transition.guardText) }
        : transition.guardKind === "slot_filled"
          ? { kind: "slot_filled", slots: [...new Set([...((transition.guardText ?? "").matchAll(slotTokenPattern))].map((match) => match[1]!).filter(Boolean))] }
          : transition.guardKind === "outcome"
            ? { kind: "outcome", status: transition.outcomeStatus ?? transition.guardText ?? "" }
            : transition.guardKind === "counter"
              ? { kind: "counter", limit: transition.counterLimit ?? Number.parseInt(transition.guardText ?? "", 10) }
              : { kind: "default" };
    const branch: RoutineDocumentBranch = {
      fromStepId: transition.fromStep,
      target: {
        kind: terminalIds.has(transition.toRef) && !stepIds.has(transition.toRef) ? "end" : "step",
        stableId: transition.toRef,
      },
      guard,
      ordinal: transition.ordinal,
    };
    transitionsByStep.set(transition.fromStep, [...(transitionsByStep.get(transition.fromStep) ?? []), branch]);
  }

  const routineSection: RoutineDocumentRoutineSection = {
    kind: "routine",
    variables: [...draft.slots].sort((left, right) => left.ordinal - right.ordinal).map((slot) => ({
      stableSlotId: slot.stableSlotId,
      key: slot.key,
      type: slot.type,
      required: slot.required,
      description: slot.description,
      ordinal: slot.ordinal,
    })),
    steps: [...draft.steps].sort((left, right) => left.ordinal - right.ordinal).map((step): RoutineDocumentStep => ({
      stableStepId: step.stableStepId,
      label: null,
      instruction: encodeRoutineDocumentText(step.instruction),
      kind: step.kind,
      toolRef: step.toolRef ?? null,
      actionType: step.actionType ?? null,
      metadata: { ...(step.metadata ?? {}) },
      ordinal: step.ordinal,
      branches: transitionsByStep.get(step.stableStepId) ?? [],
    })),
    ends: [...draft.terminals].sort((left, right) => left.ordinal - right.ordinal).map((terminal): RoutineDocumentEnd => ({
      stableStepId: terminal.stableStepId,
      kind: terminal.kind,
      instruction: terminal.instruction ? encodeRoutineDocumentText(terminal.instruction) : null,
      ordinal: terminal.ordinal,
    })),
  };

  return {
    name: draft.name,
    activation: { ...draft.activation },
    sections: [routineSection],
  };
};

const inferGuardKind = (guard: RoutineDocumentBranch["guard"]): RoutineDefinitionDraftInput["transitions"][number]["guardKind"] => guard.kind;

const transitionFieldsForGuard = (
  guard: RoutineDocumentBranch["guard"],
  slotKeys: ReadonlySet<string>,
): Pick<RoutineDefinitionDraftInput["transitions"][number], "guardText" | "outcomeStatus" | "counterLimit"> => {
  switch (guard.kind) {
    case "llm":
      return { guardText: decodeRoutineDocumentText(guard.text, slotKeys), outcomeStatus: null, counterLimit: null };
    case "slot_filled":
      return { guardText: guard.slots.map((slot) => `{{slot.${slot}}}`).join(" "), outcomeStatus: null, counterLimit: null };
    case "outcome":
      return { guardText: null, outcomeStatus: guard.status, counterLimit: null };
    case "counter":
      return { guardText: null, outcomeStatus: null, counterLimit: guard.limit };
    default:
      return { guardText: null, outcomeStatus: null, counterLimit: null };
  }
};

const routineSectionFor = (document: RoutineDocument): RoutineDocumentRoutineSection => {
  const section = document.sections.find((candidate): candidate is RoutineDocumentRoutineSection => candidate.kind === "routine");
  return section ?? { kind: "routine", variables: [], steps: [], ends: [] };
};

const addRange = (map: RoutineDocumentSourceMap, key: string, range: DocumentTextRange | undefined): void => {
  if (range) {
    map.stableIds[key] = range;
  }
};

export const routineDocumentToDraft = (document: RoutineDocument): RoutineDocumentDraftResult => {
  const diagnostics: RoutineDocumentDiagnostic[] = [];
  const sourceMap = emptySourceMap();
  const section = routineSectionFor(document);
  const slotKeys = new Set(section.variables.map((slot) => slot.key));
  const terminalIds = new Set(section.ends.map((end) => end.stableStepId));
  const transitionDrafts: RoutineDefinitionDraftInput["transitions"] = [];
  let transitionOrdinal = 0;

  for (const [stepIndex, step] of section.steps.entries()) {
    if (step.branches.length === 0 && section.steps[stepIndex + 1]) {
      const nextStep = section.steps[stepIndex + 1]!;
      if (step.range) {
        sourceMap.transitions[transitionKey(step.stableStepId, nextStep.stableStepId)] = step.range;
      }
      transitionDrafts.push({
        fromStep: step.stableStepId,
        toRef: nextStep.stableStepId,
        guardKind: "default",
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        ordinal: transitionOrdinal,
      });
      transitionOrdinal += 1;
      continue;
    }
    for (const branch of step.branches) {
      if (branch.range) {
        sourceMap.transitions[transitionKey(branch.fromStepId, branch.target.stableId)] = branch.range;
      }
      if (branch.target.kind === "step" && terminalIds.has(branch.target.stableId)) {
        diagnostics.push({
          code: "invalid_transition",
          location: `transition:${branch.fromStepId}->${branch.target.stableId}`,
          message: `invalid transition: branch from "${branch.fromStepId}" targets terminal "${branch.target.stableId}" as a step; use an end target instead.`,
          range: branch.range,
        });
        transitionOrdinal += 1;
        continue;
      }
      transitionDrafts.push({
        fromStep: branch.fromStepId,
        toRef: branch.target.stableId,
        guardKind: inferGuardKind(branch.guard),
        ...transitionFieldsForGuard(branch.guard, slotKeys),
        ordinal: transitionOrdinal,
      });
      transitionOrdinal += 1;
    }
  }

  const draft: RoutineDefinitionDraftInput = {
    name: document.name,
    activation: { ...document.activation },
    slots: section.variables.map((slot) => {
      if (slot.range) {
        sourceMap.slots[slot.key] = slot.range;
      }
      return {
        stableSlotId: slot.stableSlotId,
        key: slot.key,
        type: slot.type,
        required: slot.required,
        description: slot.description,
        ordinal: slot.ordinal,
      };
    }),
    steps: section.steps.map((step) => {
      addRange(sourceMap, step.stableStepId, step.range);
      return {
        stableStepId: step.stableStepId,
        kind: step.kind,
        instruction: decodeRoutineDocumentText(step.instruction, slotKeys),
        toolRef: step.toolRef,
        actionType: step.actionType,
        ordinal: step.ordinal,
        metadata: { ...step.metadata },
      };
    }),
    transitions: transitionDrafts,
    terminals: section.ends.map((end) => {
      addRange(sourceMap, end.stableStepId, end.range);
      return {
        stableStepId: end.stableStepId,
        kind: end.kind,
        instruction: end.instruction ? decodeRoutineDocumentText(end.instruction, slotKeys) : null,
        ordinal: end.ordinal,
      };
    }),
  };

  return { draft, diagnostics, sourceMap };
};

export const mapRoutineDiagnosticToDocumentRange = (
  diagnostic: RoutineValidationDiagnostic,
  sourceMap: RoutineDocumentSourceMap,
): DocumentTextRange | null => {
  if (diagnostic.location.startsWith("step:")) {
    return sourceMap.stableIds[diagnostic.location.slice("step:".length)] ?? null;
  }
  if (diagnostic.location.startsWith("slot:")) {
    return sourceMap.slots[diagnostic.location.slice("slot:".length)] ?? null;
  }
  if (diagnostic.location.startsWith("transition:")) {
    return sourceMap.transitions[diagnostic.location.slice("transition:".length)] ?? null;
  }
  if (diagnostic.location.startsWith("routine:")) {
    return sourceMap.routine ?? null;
  }
  return null;
};
