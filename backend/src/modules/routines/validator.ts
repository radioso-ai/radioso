import type { RoutineDefinition } from "./domain.js";

export const routineValidationCodes = [
  "unreachable_step",
  "missing_terminal",
  "dangling_action_reference",
  "dangling_step_reference",
  "missing_action_follow_up",
  "declared_unused_slot",
  "referenced_undeclared_slot",
  "unregistered_action_type",
  "action_capability_denied",
  "invalid_webhook_destination_ref",
  "unknown_webhook_destination",
  "attempt_limit_without_fallback",
  "outcome_guard_on_non_tool_step",
  "structured_guard_missing_parameter",
  "unsupported_tool_step",
  "completion_export_missing_destination",
] as const;

export type RoutineValidationCode = (typeof routineValidationCodes)[number];

export interface RoutineValidationDiagnostic {
  code: RoutineValidationCode;
  location: string;
  message: string;
}

export interface RoutineValidationResult {
  ok: boolean;
  diagnostics: RoutineValidationDiagnostic[];
}

const slotReferencePattern = /\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;

const collectSlotReferences = (text: string | null | undefined): string[] =>
  text
    ? [...text.matchAll(slotReferencePattern)].map((match) => match[1]!).filter(Boolean)
    : [];

const metadataAttemptLimit = (metadata: Record<string, unknown>): number | null =>
  typeof metadata.attemptLimit === "number" && Number.isInteger(metadata.attemptLimit) && metadata.attemptLimit > 0
    ? metadata.attemptLimit
    : null;

const parsePositiveInteger = (value: string | null): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && String(parsed) === value.trim() ? parsed : null;
};

export const validateRoutineDefinition = (definition: RoutineDefinition): RoutineValidationResult => {
  const diagnostics: RoutineValidationDiagnostic[] = [];
  const steps = [...definition.steps].sort((left, right) => left.ordinal - right.ordinal);
  const terminals = [...definition.terminals].sort((left, right) => left.ordinal - right.ordinal);
  const stepIds = new Set(steps.map((step) => step.stableStepId));
  const stepById = new Map(steps.map((step) => [step.stableStepId, step]));
  const terminalIds = new Set(terminals.map((terminal) => terminal.stableStepId));
  const nodeIds = new Set([...stepIds, ...terminalIds]);

  if (terminals.length === 0) {
    diagnostics.push({
      code: "missing_terminal",
      location: `routine:${definition.name}`,
      message: `missing terminal: routine "${definition.name}" must declare at least one terminal.`,
    });
  }

  if (definition.completionExport?.enabled && definition.completionExport.destinationRef.trim().length === 0) {
    diagnostics.push({
      code: "completion_export_missing_destination",
      location: "completionExport.destinationRef",
      message: "completion export missing destination: enabled completion export must reference a webhook destination.",
    });
  }

  for (const step of steps) {
    if (step.kind === "tool") {
      diagnostics.push({
        code: "unsupported_tool_step",
        location: `step:${step.stableStepId}`,
        message: `tool steps are not yet supported: step "${step.stableStepId}" cannot be published until routine tool dispatch is available.`,
      });
    }
    if (step.kind === "tool" && !step.toolRef) {
      diagnostics.push({
        code: "dangling_action_reference",
        location: `step:${step.stableStepId}`,
        message: `dangling action reference: step "${step.stableStepId}" is a tool step but has no tool reference.`,
      });
    }
    if (step.kind === "action" && !step.actionType) {
      diagnostics.push({
        code: "dangling_action_reference",
        location: `step:${step.stableStepId}`,
        message: `dangling action reference: step "${step.stableStepId}" is an action step but has no action type.`,
      });
    }
  }

  for (const transition of definition.transitions) {
    if (!stepIds.has(transition.fromStep)) {
      diagnostics.push({
        code: "dangling_step_reference",
        location: `transition:${transition.fromStep}->${transition.toRef}`,
        message: `dangling step reference: transition starts at unknown step "${transition.fromStep}".`,
      });
    }
    if (!nodeIds.has(transition.toRef)) {
      diagnostics.push({
        code: "dangling_step_reference",
        location: `transition:${transition.fromStep}->${transition.toRef}`,
        message: `dangling step reference: transition points to unknown step or terminal "${transition.toRef}".`,
      });
    }
    if (transition.guardKind === "outcome") {
      const fromStep = stepById.get(transition.fromStep);
      if (fromStep && fromStep.kind !== "tool") {
        diagnostics.push({
          code: "outcome_guard_on_non_tool_step",
          location: `transition:${transition.fromStep}->${transition.toRef}`,
          message: `outcome guard on non-tool step: transition "${transition.fromStep}" to "${transition.toRef}" uses an outcome guard but does not leave a tool step.`,
        });
      }
      if (!transition.outcomeStatus && !transition.guardText) {
        diagnostics.push({
          code: "structured_guard_missing_parameter",
          location: `transition:${transition.fromStep}->${transition.toRef}`,
          message: `structured guard missing parameter: outcome guard from "${transition.fromStep}" must declare an outcome status.`,
        });
      }
    }
    if (transition.guardKind === "counter" && !transition.counterLimit && parsePositiveInteger(transition.guardText) === null) {
      diagnostics.push({
        code: "structured_guard_missing_parameter",
        location: `transition:${transition.fromStep}->${transition.toRef}`,
        message: `structured guard missing parameter: counter guard from "${transition.fromStep}" must declare a positive limit.`,
      });
    }
  }

  const slotKeys = new Set(definition.slots.map((slot) => slot.key));
  const referencedSlotKeys = new Set<string>();
  for (const step of steps) {
    for (const key of collectSlotReferences(step.instruction)) {
      referencedSlotKeys.add(key);
    }
  }
  for (const transition of definition.transitions) {
    for (const key of collectSlotReferences(transition.guardText)) {
      referencedSlotKeys.add(key);
    }
  }

  for (const step of steps) {
    if (step.kind !== "action") {
      continue;
    }
    const hasReachableFollowUp = definition.transitions.some((transition) =>
      transition.fromStep === step.stableStepId && nodeIds.has(transition.toRef)
    );
    if (!hasReachableFollowUp) {
      diagnostics.push({
        code: "missing_action_follow_up",
        location: `step:${step.stableStepId}`,
        message: `missing action follow-up: action step "${step.stableStepId}" must declare an outgoing transition to another step or terminal.`,
      });
    }
  }
  for (const terminal of terminals) {
    for (const key of collectSlotReferences(terminal.instruction)) {
      referencedSlotKeys.add(key);
    }
  }

  for (const key of referencedSlotKeys) {
    if (!slotKeys.has(key)) {
      diagnostics.push({
        code: "referenced_undeclared_slot",
        location: `slot:${key}`,
        message: `referenced-but-undeclared slot: "${key}" is referenced but is not declared.`,
      });
    }
  }
  for (const slot of definition.slots) {
    if (!referencedSlotKeys.has(slot.key)) {
      diagnostics.push({
        code: "declared_unused_slot",
        location: `slot:${slot.key}`,
        message: `declared-but-unused slot: "${slot.key}" is declared but never referenced.`,
      });
    }
  }

  const outgoing = new Map<string, string[]>();
  for (const transition of definition.transitions) {
    const existing = outgoing.get(transition.fromStep) ?? [];
    existing.push(transition.toRef);
    outgoing.set(transition.fromStep, existing);
  }
  const rootStepId = steps[0]?.stableStepId;
  const reachable = new Set<string>();
  const queue = rootStepId ? [rootStepId] : [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) {
      continue;
    }
    reachable.add(id);
    for (const target of outgoing.get(id) ?? []) {
      if (!reachable.has(target)) {
        queue.push(target);
      }
    }
  }

  for (const step of steps) {
    if (!reachable.has(step.stableStepId)) {
      diagnostics.push({
        code: "unreachable_step",
        location: `step:${step.stableStepId}`,
        message: `unreachable step: step "${step.stableStepId}" cannot be reached from the first step.`,
      });
    }
  }
  if (terminalIds.size > 0 && ![...terminalIds].some((id) => reachable.has(id))) {
    diagnostics.push({
      code: "missing_terminal",
      location: `routine:${definition.name}`,
      message: `missing terminal: no terminal is reachable from the first step.`,
    });
  }

  for (const step of steps) {
    if (metadataAttemptLimit(step.metadata) === null) {
      continue;
    }
    const hasFallbackTerminal = definition.transitions.some((transition) =>
      transition.fromStep === step.stableStepId &&
      transition.guardKind === "default" &&
      terminalIds.has(transition.toRef)
    );
    if (!hasFallbackTerminal) {
      diagnostics.push({
        code: "attempt_limit_without_fallback",
        location: `step:${step.stableStepId}`,
        message: `attempt-limit-without-fallback: step "${step.stableStepId}" declares an attempt limit but has no fallback transition to a terminal.`,
      });
    }
  }

  for (const transition of definition.transitions) {
    if (transition.guardKind !== "counter") {
      continue;
    }
    const hasTerminalPath =
      terminalIds.has(transition.toRef) ||
      definition.transitions.some((candidate) =>
        candidate.fromStep === transition.fromStep &&
        candidate.guardKind === "default" &&
        terminalIds.has(candidate.toRef)
      );
    if (!hasTerminalPath) {
      diagnostics.push({
        code: "attempt_limit_without_fallback",
        location: `transition:${transition.fromStep}->${transition.toRef}`,
        message: `attempt-limit-without-fallback: counter guard from "${transition.fromStep}" has no fallback or terminal handoff path.`,
      });
    }
  }

  // Slice 3 seam: validate referenced action types against the action registry and
  // per-agent capability policy before publish.
  return { ok: diagnostics.length === 0, diagnostics };
};
