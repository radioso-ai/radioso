import type {
  RoutineFieldGuardOp,
  RoutineFieldGuardUnit,
  RoutineInputBinding,
  RoutineDefinitionDraftInput,
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

export type RoutineDefinitionDraft = RoutineDefinitionDraftInput;
export type RoutineSlot = RoutineDefinitionDraftInput["slots"][number];
export type RoutineStep = RoutineDefinitionDraftInput["steps"][number];
export type RoutineTransition = RoutineDefinitionDraftInput["transitions"][number];
export type RoutineTerminal = RoutineDefinitionDraftInput["terminals"][number];
export type RoutineCompletionExport = NonNullable<RoutineDefinitionDraftInput["completionExport"]>;

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

export type ProseDoc = {
  variables: ChipDocVariable[];
  paragraphs: ProseParagraph[];
};

export type ParseDiagnostic = {
  line: number;
  code: string;
  message: string;
};

export const OUTCOME_GUARD_REF = "__outcome__";
export const SLOT_FILLED_GUARD_REF = "__filled__";
