// A yielded routine's pending step steers the turn's answer as a closing lead-back (#1377).
export type { RoutinePendingStep, SteeringRule } from "@radioso/conversation-contract";
export {
  addressesSurface,
  appendSteeringRules,
  effectiveSurfaces,
  orderSteeringRules,
  // A routine step's steering in its two roles (#1351): the step's rule controls
  // the reply, directives render as guidance subordinate to it.
  partitionRoutineStepSteering,
  renderRoutineStepInstructions,
  renderSteeringRules,
  resolveRenderSurfaces,
  routineStepSteeringOptions,
  // Narrowing a steering set to one generation surface is a steering operation, so it
  // enters the backend through this sanctioned barrel rather than a second one.
  steeringForSurface,
  type RenderSteeringRulesOptions,
} from "@radioso/conversation-defaults";
export {
  // Narrowing a steering set to an already-known coverage verdict is likewise a
  // steering operation; the engine owns the criteria semantics, the backend only
  // applies them where a generator runs after the verdict exists.
  steeringForKnownVerdict,
  // The engine's own `answer_coverage_head` trace stage and this backend's
  // `chat_answer_coverage_head_parse_total` metric must bucket a reported
  // assessment the same way; the engine owns that mapping, this barrel is
  // where the backend reads it from (#1260 R2).
  answerCoverageHeadParseOutcome,
} from "@radioso/conversation-engine";
