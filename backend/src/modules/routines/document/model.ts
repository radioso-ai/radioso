import type { RoutineDefinitionDraftInput } from "../domain.js";

export type RoutineDocumentSectionKind = "routine" | "guidelines" | "glossary";

export interface DocumentPosition {
  offset: number;
  line: number;
  column: number;
}

export interface DocumentTextRange {
  start: DocumentPosition;
  end: DocumentPosition;
}

export interface RoutineDocumentSourceMap {
  stableIds: Record<string, DocumentTextRange>;
  slots: Record<string, DocumentTextRange>;
  transitions: Record<string, DocumentTextRange>;
  routine?: DocumentTextRange;
}

export type RoutineDocumentDiagnosticCode =
  | "ambiguous_reference_name"
  | "duplicate_anchor"
  | "invalid_frontmatter"
  | "invalid_guard_marker"
  | "invalid_section"
  | "invalid_transition"
  | "missing_anchor"
  | "missing_frontmatter"
  | "missing_section"
  | "token_less_branch_beat";

export interface RoutineDocumentDiagnostic {
  code: RoutineDocumentDiagnosticCode;
  location: string;
  message: string;
  range?: DocumentTextRange;
}

export type RoutineReferenceTokenKind = "variable" | "action";
export type RoutineFlowTargetKind = "step" | "end";

export interface RoutineDocumentReferenceToken {
  kind: RoutineReferenceTokenKind;
  name: string;
}

export interface RoutineDocumentVariable {
  stableSlotId: string;
  key: string;
  type: RoutineDefinitionDraftInput["slots"][number]["type"];
  required: boolean;
  description: string | null;
  ordinal: number;
  range?: DocumentTextRange;
}

export type RoutineDocumentGuard =
  | { kind: "default" }
  | { kind: "llm"; text: string }
  | { kind: "slot_filled"; slots: string[] }
  | { kind: "outcome"; status: string }
  | { kind: "counter"; limit: number };

export interface RoutineDocumentBranch {
  fromStepId: string;
  target: {
    kind: RoutineFlowTargetKind;
    stableId: string;
  };
  guard: RoutineDocumentGuard;
  ordinal: number;
  range?: DocumentTextRange;
}

export interface RoutineDocumentStep {
  stableStepId: string;
  label: string | null;
  instruction: string;
  kind: RoutineDefinitionDraftInput["steps"][number]["kind"];
  toolRef: string | null;
  actionType: string | null;
  metadata: Record<string, unknown>;
  ordinal: number;
  branches: RoutineDocumentBranch[];
  range?: DocumentTextRange;
}

export interface RoutineDocumentEnd {
  stableStepId: string;
  kind: RoutineDefinitionDraftInput["terminals"][number]["kind"];
  instruction: string | null;
  ordinal: number;
  range?: DocumentTextRange;
}

export interface RoutineDocumentRoutineSection {
  kind: "routine";
  variables: RoutineDocumentVariable[];
  steps: RoutineDocumentStep[];
  ends: RoutineDocumentEnd[];
}

export interface RoutineDocumentPlaceholderSection {
  kind: "guidelines" | "glossary";
  lines: string[];
  range?: DocumentTextRange;
}

export type RoutineDocumentSection = RoutineDocumentRoutineSection | RoutineDocumentPlaceholderSection;

export interface RoutineDocument {
  name: string;
  activation: RoutineDefinitionDraftInput["activation"];
  sections: RoutineDocumentSection[];
}

export interface RoutineDocumentParseOptions {
  actionNames?: readonly string[];
  actionKinds?: Readonly<Record<string, "tool" | "action">>;
}

export interface RoutineDocumentParseResult {
  document: RoutineDocument;
  diagnostics: RoutineDocumentDiagnostic[];
  sourceMap: RoutineDocumentSourceMap;
}

export interface RoutineDocumentDraftResult {
  draft: RoutineDefinitionDraftInput;
  diagnostics: RoutineDocumentDiagnostic[];
  sourceMap: RoutineDocumentSourceMap;
}
