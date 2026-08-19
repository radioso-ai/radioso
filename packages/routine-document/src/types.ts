import type {
  RoutineFieldGuardOp,
  RoutineFieldGuardUnit,
  RoutineInputBinding,
  RoutineDefinitionDraftInput,
  RoutineDefinitionDraftAuthoringInput,
  RoutineSlotType,
  RoutineStepMode,
} from "@radioso/routine-definition";

export type {
  RoutineFieldGuardOp,
  RoutineFieldGuardUnit,
  RoutineInputBinding,
  RoutineSlotType,
  RoutineStepMode,
};

// Read side: loaded drafts are complete (Zod defaults applied).
export type RoutineDefinitionDraft = RoutineDefinitionDraftInput;
// Loose read-side source: consumers hold API-typed or authoring-shaped drafts
// where Zod-defaulted fields may be absent. Readers normalize internally
// instead of demanding the parsed shape (liberal in, canonical out).
export type RoutineDraftSource = RoutineDefinitionDraftAuthoringInput;
export type RoutineDraftSourceTerminal = NonNullable<RoutineDraftSource["terminals"]>[number];
export type RoutineDraftSourceSlot = NonNullable<RoutineDraftSource["slots"]>[number];
export type RoutineDraftSourceStep = NonNullable<RoutineDraftSource["steps"]>[number];
export type RoutineDraftSourceTransition = NonNullable<RoutineDraftSource["transitions"]>[number];
// Produce side: what the grammar emits toward a save is pre-parse authoring
// input — Zod-defaulted fields (e.g. activation.reentryMode) may be absent.
export type RoutineDefinitionDraftAuthoring = RoutineDefinitionDraftAuthoringInput;
// What draftFromChipDoc actually constructs: authoring input, but the arrays and
// gateRef are always present (reentryMode/priority remain host-carried headers).
// Emitted elements are complete (every field explicit), so they carry the
// parsed element types even though top-level defaulted headers stay optional.
export type RoutineDefinitionDraftAuthored = Omit<RoutineDefinitionDraftAuthoring, "activation" | "slots" | "steps" | "transitions" | "terminals" | "completionExport"> & {
  activation: RoutineDefinitionDraftAuthoring["activation"] & { gateRef: string | null };
  slots: RoutineSlot[];
  steps: RoutineStep[];
  transitions: RoutineTransition[];
  terminals: RoutineTerminal[];
  completionExport?: RoutineCompletionExport;
};
export type RoutineSlot = RoutineDefinitionDraft["slots"][number];
export type RoutineStep = RoutineDefinitionDraft["steps"][number];
export type RoutineTransition = RoutineDefinitionDraft["transitions"][number];
export type RoutineTerminal = RoutineDefinitionDraft["terminals"][number];
export type RoutineCompletionExport = NonNullable<RoutineDefinitionDraft["completionExport"]>;

export type RoutineFieldGuardValue = string | number | boolean;

export type ChipDocVariable = {
  id: string;
  name: string;
  type: RoutineSlotType;
  required?: boolean;
  mutable?: boolean;
};

export type ApprovalDocOption = {
  id: string;
  label: string;
  description?: string | null;
  target?: string;
};

export type ProseChipKind =
  | "variable"
  | "skill"
  | "action"
  | "handoff"
  | "step"
  | "condition"
  | "end"
  | "approval"
  | "decision";

export type ProseSegment =
  | { kind: "text"; text: string }
  | {
      kind: "chip";
      chipKind: ProseChipKind;
      refId: string;
      label: string;
      op?: RoutineFieldGuardOp;
      value?: RoutineFieldGuardValue | null;
      values?: RoutineFieldGuardValue[] | null;
      unit?: RoutineFieldGuardUnit | null;
      counterLimit?: number | null;
      inputBindings?: Record<string, RoutineInputBinding>;
      outputAssignments?: Record<string, string>;
      mode?: RoutineStepMode;
      captureKey?: string | null;
      options?: ApprovalDocOption[];
    };

export type ProseParagraph = { headingLevel?: 1; segments: ProseSegment[] };

export type ProseTerminal = { id?: string; instruction?: string | null };
export type ProseTerminalConfig = { complete?: ProseTerminal | null; handoff?: ProseTerminal | null };

// Where a token failed to parse, so a caller can point at the line.
export type ParseDiagnostic = {
  line: number;
  code: string;
  message: string;
};

export const OUTCOME_GUARD_REF = "__outcome__";
export const SLOT_FILLED_GUARD_REF = "__filled__";
