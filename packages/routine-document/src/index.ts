export * from "./types.js";
export type {
  RoutineDocBlock,
  RoutineDocChip,
  RoutineSkillBindingState,
} from "./document.js";
export type {
  RoutineBlockBranch,
  RoutineBlockBranchTarget,
  RoutineBlockDiagnostic,
  RoutineBlockDoc,
  RoutineBlockEnding,
  RoutineBlockGuard,
  RoutineBlockInstructionSegment,
  RoutineBlockSlot,
  RoutineBlockStep,
  RoutineToBlockDocResult,
} from "./block-document.js";
export {
  blockSegmentsToInstruction,
  draftFromBlockDoc,
  instructionToBlockSegments,
  routineToBlockDoc,
} from "./block-document.js";
export {
  branchDecisionLabel,
  fieldGuardOpLabel,
  fieldGuardOpNeedsUnit,
  fieldGuardOpNeedsValue,
  fieldGuardOpsForType,
  formatConditionLabel,
  formatSlotFilledLabel,
  ROUTINE_FIELD_GUARD_UNITS,
  readProseCompletionExport,
  readProseTerminals,
  ROUTINE_SLOT_TYPES,
  routineToChipDoc,
  slugifyVariableKey,
} from "./document.js";
// Inline chip tokens: the `#skill` / `@variable` marks an author writes inside one field.
// Skill-mention surfaces read and write them, so the token layer outlives the portable
// routine document that used to wrap it.
export type { ParsedProseDoc } from "./tokens.js";
export {
  parseProseDoc,
  serializeProseDoc,
  tokenForChip,
} from "./tokens.js";
