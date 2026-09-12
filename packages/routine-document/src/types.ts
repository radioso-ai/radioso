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
// What draftFromBlockDoc actually constructs: authoring input, but the arrays and
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

// A variable carried on the chip document. `required`/`mutable` are omitted in the common
// case (required, non-mutable) so the bare `{ id, name, type }` shape round-trips unchanged;
// they're only present when the author marks a slot optional or editable-after-completion.
export type ChipDocVariable = {
  id: string;
  name: string;
  type: RoutineSlotType;
  required?: boolean;
  mutable?: boolean;
};

// One option of an approval gate, as carried on an `approval` chip: its id/label/optional
// description plus the step or terminal the routine branches to when a human picks it.
export type ApprovalDocOption = {
  id: string;
  label: string;
  description?: string | null;
  // Where the routine continues when a person picks this choice. Carried on the block-chip
  // model; absent in the inline model, where the target lives on a separate branch line.
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

// One inline piece of a prose paragraph: literal text or a chip. This preserves where each
// chip sits inline, rather than flattening a paragraph to separate text/chips lists.
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
      // For a `step` (jump) chip that loops back: the max iterations (counter bound).
      counterLimit?: number | null;
      inputBindings?: Record<string, RoutineInputBinding>;
      outputAssignments?: Record<string, string>;
      mode?: RoutineStepMode;
      // For an `approval` chip: the capture slot and the options (each with its target).
      captureKey?: string | null;
      options?: ApprovalDocOption[];
    };

// A paragraph is a step title (headingLevel 1) or ordinary prose/branch content. The
// title pins the step's stable id + label; the following non-heading paragraphs are its
// body. Headings let an author name a step so a jump can target it.
export type ProseParagraph = { headingLevel?: 1; segments: ProseSegment[] };

export type ProseTerminal = { id?: string; instruction?: string | null };
export type ProseTerminalConfig = { complete?: ProseTerminal | null; handoff?: ProseTerminal | null };

// Where a token failed to parse, so a caller can point at the line.
export type ParseDiagnostic = {
  line: number;
  code: string;
  message: string;
};

// A condition chip whose refId is this sentinel is an outcome guard, not a variable
// comparison: it branches on the preceding tool step's result status (carried in the chip's
// `value`), compiling to a `guardKind: 'outcome'` transition. The sentinel can't collide with
// a real variable id — slugifyVariableKey strips leading/trailing underscores, so it never
// produces `__outcome__`.
export const OUTCOME_GUARD_REF = "__outcome__";

// A condition chip whose refId is this sentinel is a slot-filled guard, not a variable
// comparison: it continues only once the named slots are present, compiling to a
// `guardKind: 'slot_filled'` transition. The slot keys ride in the chip's `values`. Like the
// outcome sentinel it can't collide with a real variable id (slugifyVariableKey strips the
// surrounding underscores, so it never produces `__filled__`).
export const SLOT_FILLED_GUARD_REF = "__filled__";
