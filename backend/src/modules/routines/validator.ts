import type { RoutineDefinition } from "./domain.js";
import type { SkillAuthoringDescriptor, SkillAuthoringInput } from "../skills/authoringDescriptor.js";
import { analyzeGuaranteedVariablesOnEntry } from "./variablePopulation.js";

export const routineValidationCodes = [
  "unreachable_step",
  "missing_terminal",
  "dangling_action_reference",
  "dangling_step_reference",
  "unbounded_back_edge",
  "missing_action_follow_up",
  "declared_unused_slot",
  "referenced_undeclared_slot",
  "unregistered_action_type",
  "unknown_skill",
  "action_capability_denied",
  "invalid_webhook_destination_ref",
  "unknown_webhook_destination",
  "attempt_limit_without_fallback",
  "outcome_guard_on_non_tool_step",
  "structured_guard_missing_parameter",
  "field_guard_unknown_reference",
  "field_guard_incompatible_type",
  "completion_export_missing_destination",
  "approval_step_llm_edge",
  "approval_step_no_decision_edge",
  "approval_step_unknown_option",
  "approval_step_unreachable_option",
  "unsatisfiable_required_input",
  "input_type_mismatch",
  "unknown_input_binding",
  "unknown_variable_ref",
  "variable_name_collision",
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

export interface RoutineValidationContext {
  availableSkillNames?: ReadonlySet<string>;
  skillDescriptors?: ReadonlyMap<string, SkillAuthoringDescriptor>;
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

const isBackEdge = (
  transition: RoutineDefinition["transitions"][number],
  stepOrdinalById: ReadonlyMap<string, number>,
): boolean => {
  const fromOrdinal = stepOrdinalById.get(transition.fromStep);
  const toOrdinal = stepOrdinalById.get(transition.toRef);
  return fromOrdinal !== undefined && toOrdinal !== undefined && toOrdinal <= fromOrdinal;
};

// A field guard's operator must fit the variable's type: relative-date ops need a date,
// numeric comparisons need a number, boolean checks need a boolean. The rest apply to any.
const isFieldOpCompatible = (op: string, slotType: string): boolean => {
  if (op === "older_than" || op === "within") return slotType === "date";
  if (op === "gt" || op === "gte" || op === "lt" || op === "lte") return slotType === "number";
  if (op === "is_true" || op === "is_false") return slotType === "boolean";
  return true;
};

const expectedRuntimeType = (inputType: SkillAuthoringInput["type"]): "string" | "number" | "boolean" => {
  if (inputType === "number") return "number";
  if (inputType === "boolean") return "boolean";
  return "string";
};

const isSlotTypeCompatibleWithInput = (
  slotType: RoutineDefinition["slots"][number]["type"],
  inputType: SkillAuthoringInput["type"],
): boolean => {
  if (inputType === "number") return slotType === "number";
  if (inputType === "boolean") return slotType === "boolean";
  return slotType === "text" || slotType === "email" || slotType === "date";
};

const parsePositiveInteger = (value: string | null): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && String(parsed) === value.trim() ? parsed : null;
};

// The ONLY decision path resume populates is `<captureKey>.id` (the chosen option id);
// resume writes `{ id, payload }` under the capture key, so any other `<captureKey>.*`
// ref (e.g. a typo'd `.foo`) resolves to undefined and the branch can never fire. Exempt
// only the exact `.id` ref from the declared-variable check; everything else stays unknown.
const approvalDecisionRef = (captureKey: string): string => `${captureKey}.id`;

const isApprovalDecisionFieldRef = (
  transition: RoutineDefinition["transitions"][number],
  stepById: ReadonlyMap<string, RoutineDefinition["steps"][number]>,
): boolean => {
  const fromStep = stepById.get(transition.fromStep);
  return fromStep?.kind === "approval" &&
    Boolean(fromStep.captureKey) &&
    transition.fieldRef === approvalDecisionRef(fromStep.captureKey as string);
};

export const validateRoutineDefinition = (
  definition: RoutineDefinition,
  context: RoutineValidationContext = {},
): RoutineValidationResult => {
  const diagnostics: RoutineValidationDiagnostic[] = [];
  const steps = [...definition.steps].sort((left, right) => left.ordinal - right.ordinal);
  const terminals = [...definition.terminals].sort((left, right) => left.ordinal - right.ordinal);
  const stepIds = new Set(steps.map((step) => step.stableStepId));
  const stepById = new Map(steps.map((step) => [step.stableStepId, step]));
  const stepOrdinalById = new Map(steps.map((step) => [step.stableStepId, step.ordinal]));
  const terminalIds = new Set(terminals.map((terminal) => terminal.stableStepId));
  const nodeIds = new Set([...stepIds, ...terminalIds]);
  const availableSkillNames = context.availableSkillNames ?? (
    context.skillDescriptors ? new Set(context.skillDescriptors.keys()) : undefined
  );
  const slotKeys = new Set(definition.slots.map((slot) => slot.key));
  const slotByKey = new Map(definition.slots.map((slot) => [slot.key, slot]));
  const outputAssignmentEntries = steps.flatMap((step) =>
    Object.entries(step.metadata.outputAssignments ?? {}).map(([outputKey, target]) => ({
      stepId: step.stableStepId,
      outputKey,
      target,
    }))
  );
  const outputAssignmentTargetsByName = new Map<string, typeof outputAssignmentEntries>();
  for (const entry of outputAssignmentEntries) {
    outputAssignmentTargetsByName.set(entry.target, [
      ...(outputAssignmentTargetsByName.get(entry.target) ?? []),
      entry,
    ]);
  }
  // The routine's variable namespace: customer-collected slots plus skill-output
  // assignments. A `variableRef` binding may only point into this set.
  const knownVariableNames = new Set<string>([
    ...slotKeys,
    ...outputAssignmentEntries.map((entry) => entry.target),
  ]);
  const guaranteedVariablesOnEntry = analyzeGuaranteedVariablesOnEntry(definition);

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
    // A tool step compiles to a skill step dispatched through the shared
    // skill-executor port (see RoutineSkillExecutorDispatcher); it must name the
    // authored skill it invokes — an unbound tool step is the dangling case.
    if (step.kind === "tool" && !step.toolRef) {
      diagnostics.push({
        code: "dangling_action_reference",
        location: `step:${step.stableStepId}`,
        message: `dangling action reference: step "${step.stableStepId}" is a tool step but has no tool reference.`,
      });
    } else if (
      step.kind === "tool" &&
      availableSkillNames &&
      step.toolRef &&
      !availableSkillNames.has(step.toolRef)
    ) {
      diagnostics.push({
        code: "unknown_skill",
        location: `step:${step.stableStepId}`,
        message: `unknown skill: tool step "${step.stableStepId}" references "${step.toolRef}", but that skill is not available to this agent.`,
      });
    }
    if (step.kind === "action" && !step.actionType) {
      diagnostics.push({
        code: "dangling_action_reference",
        location: `step:${step.stableStepId}`,
        message: `dangling action reference: step "${step.stableStepId}" is an action step but has no action type.`,
      });
    }
    if (step.kind === "approval" && step.captureKey) {
      const decisionRef = approvalDecisionRef(step.captureKey);
      const outgoingTransitions = definition.transitions.filter((transition) => transition.fromStep === step.stableStepId);
      for (const transition of outgoingTransitions) {
        if (transition.guardKind === "llm") {
          diagnostics.push({
            code: "approval_step_llm_edge",
            location: `step:${step.stableStepId}`,
            message: `approval step llm edge: approval step "${step.stableStepId}" must branch with deterministic decision guards.`,
          });
        }
      }
      // The decision edges branch on the chosen option id via `<captureKey>.id == <optionId>`.
      const decisionEdges = outgoingTransitions.filter(
        (transition) => transition.guardKind === "field" && transition.fieldRef === decisionRef && transition.fieldOp === "equals",
      );
      if (decisionEdges.length === 0) {
        diagnostics.push({
          code: "approval_step_no_decision_edge",
          location: `step:${step.stableStepId}`,
          message: `approval step no decision edge: approval step "${step.stableStepId}" must branch on "${decisionRef}".`,
        });
      }
      const optionIds = new Set((step.options ?? []).map((option) => option.id));
      // An edge whose value is not a declared option can never match → dead branch.
      for (const edge of decisionEdges) {
        const value = typeof edge.fieldValue === "string" ? edge.fieldValue : null;
        if (value === null || !optionIds.has(value)) {
          diagnostics.push({
            code: "approval_step_unknown_option",
            location: `transition:${edge.fromStep}->${edge.toRef}`,
            message: `approval step unknown option: decision edge on "${decisionRef}" compares to "${value ?? edge.fieldValue ?? ""}", which is not a declared option of step "${step.stableStepId}".`,
          });
        }
      }
      // A declared option with no edge is unreachable → the chosen outcome falls through.
      const branchedValues = new Set(
        decisionEdges
          .map((edge) => (typeof edge.fieldValue === "string" ? edge.fieldValue : null))
          .filter((value): value is string => value !== null),
      );
      for (const option of step.options ?? []) {
        if (!branchedValues.has(option.id)) {
          diagnostics.push({
            code: "approval_step_unreachable_option",
            location: `step:${step.stableStepId}`,
            message: `approval step unreachable option: option "${option.id}" of step "${step.stableStepId}" has no decision edge on "${decisionRef}".`,
          });
        }
      }
    }
  }

  for (const entry of outputAssignmentEntries) {
    if (slotKeys.has(entry.target)) {
      diagnostics.push({
        code: "variable_name_collision",
        location: `step:${entry.stepId}.outputAssignments.${entry.outputKey}`,
        message: `variable name collision: output assignment target "${entry.target}" collides with a declared slot key.`,
      });
    }
    const duplicateEntries = outputAssignmentTargetsByName.get(entry.target) ?? [];
    if (duplicateEntries.length > 1) {
      diagnostics.push({
        code: "variable_name_collision",
        location: `step:${entry.stepId}.outputAssignments.${entry.outputKey}`,
        message: `variable name collision: output assignment target "${entry.target}" is assigned by multiple tool outputs.`,
      });
    }
  }

  if (context.skillDescriptors) {
    for (const step of steps) {
      if (step.kind !== "tool" || !step.toolRef) {
        continue;
      }
      const descriptor = context.skillDescriptors.get(step.toolRef);
      if (!descriptor) {
        continue;
      }
      const inputsByKey = new Map(descriptor.inputs.map((input) => [input.key, input]));
      const inputBindings = step.metadata.inputBindings ?? {};
      for (const [inputKey, binding] of Object.entries(inputBindings)) {
        const input = inputsByKey.get(inputKey);
        if (!input) {
          diagnostics.push({
            code: "unknown_input_binding",
            location: `step:${step.stableStepId}.inputBindings.${inputKey}`,
            message: `unknown input binding: skill "${step.toolRef}" does not declare an input named "${inputKey}".`,
          });
          continue;
        }
        const expectedType = expectedRuntimeType(input.type);
        if (binding.kind === "literal") {
          const literalType = typeof binding.value;
          const enumAllowed = input.type !== "enum" || !input.enumValues || input.enumValues.includes(String(binding.value));
          if (literalType !== expectedType || !enumAllowed) {
            diagnostics.push({
              code: "input_type_mismatch",
              location: `step:${step.stableStepId}.inputBindings.${inputKey}`,
              message: `input type mismatch: binding for "${inputKey}" must be a ${input.type} value accepted by skill "${step.toolRef}".`,
            });
          }
        } else if (!knownVariableNames.has(binding.ref)) {
          diagnostics.push({
            code: "unknown_variable_ref",
            location: `step:${step.stableStepId}.inputBindings.${inputKey}`,
            message: `unknown variable reference: binding for "${inputKey}" references variable "${binding.ref}", which is not a declared slot or skill-output assignment.`,
          });
        } else {
          const slot = slotByKey.get(binding.ref);
          if (slot && !isSlotTypeCompatibleWithInput(slot.type, input.type)) {
            diagnostics.push({
              code: "input_type_mismatch",
              location: `step:${step.stableStepId}.inputBindings.${inputKey}`,
              message: `input type mismatch: variable "${binding.ref}" has type ${slot.type}, but skill "${step.toolRef}" input "${inputKey}" expects ${input.type}.`,
            });
          }
        }
      }
      const guaranteed = guaranteedVariablesOnEntry.get(step.stableStepId) ?? new Set<string>();
      for (const input of descriptor.inputs) {
        if (!input.required) {
          continue;
        }
        const binding = inputBindings[input.key];
        if (!binding) {
          diagnostics.push({
            code: "unsatisfiable_required_input",
            location: `step:${step.stableStepId}.inputBindings.${input.key}`,
            message: `unsatisfiable required input: skill "${step.toolRef}" requires input "${input.key}", but the routine does not bind it.`,
          });
        } else if (
          binding.kind === "variableRef" &&
          knownVariableNames.has(binding.ref) &&
          !guaranteed.has(binding.ref)
        ) {
          // An unknown ref is reported once by the per-binding `unknown_variable_ref`
          // check above; here we only flag a real variable that isn't guaranteed yet.
          diagnostics.push({
            code: "unsatisfiable_required_input",
            location: `step:${step.stableStepId}.inputBindings.${input.key}`,
            message: `unsatisfiable required input: variable "${binding.ref}" is not guaranteed before step "${step.stableStepId}".`,
          });
        }
      }
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
    // Conservative v1 loop safety: the bound must be on the back-edge itself,
    // not merely somewhere else in the cycle.
    if (isBackEdge(transition, stepOrdinalById) && transition.guardKind !== "counter") {
      diagnostics.push({
        code: "unbounded_back_edge",
        location: `transition:${transition.fromStep}->${transition.toRef}`,
        message: `unbounded back-edge: transition from "${transition.fromStep}" to "${transition.toRef}" targets an earlier-or-same step and must use a counter guard.`,
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
    if (transition.guardKind === "field") {
      const location = `transition:${transition.fromStep}->${transition.toRef}`;
      const op = transition.fieldOp;
      const opNeedsValue = op === "equals" || op === "not_equals" || op === "gt" || op === "gte" || op === "lt" || op === "lte" || op === "older_than" || op === "within";
      const opNeedsUnit = op === "older_than" || op === "within";
      if (!transition.fieldRef || !op) {
        diagnostics.push({
          code: "structured_guard_missing_parameter",
          location,
          message: `structured guard missing parameter: field guard from "${transition.fromStep}" must declare a field reference and operator.`,
        });
      } else if (opNeedsValue && (transition.fieldValue === null || transition.fieldValue === undefined)) {
        diagnostics.push({
          code: "structured_guard_missing_parameter",
          location,
          message: `structured guard missing parameter: field guard "${op}" from "${transition.fromStep}" must declare a value.`,
        });
      } else if (op === "in" && (!transition.fieldValues || transition.fieldValues.length === 0)) {
        diagnostics.push({
          code: "structured_guard_missing_parameter",
          location,
          message: `structured guard missing parameter: field guard "in" from "${transition.fromStep}" must declare a non-empty values list.`,
        });
      } else if (opNeedsUnit && !transition.fieldUnit) {
        diagnostics.push({
          code: "structured_guard_missing_parameter",
          location,
          message: `structured guard missing parameter: field guard "${op}" from "${transition.fromStep}" must declare a duration unit.`,
        });
      }
    }
  }

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
    if (transition.guardKind === "field" && transition.fieldRef) {
      const slot = slotByKey.get(transition.fieldRef);
      if (
        !knownVariableNames.has(transition.fieldRef) &&
        !isApprovalDecisionFieldRef(transition, stepById)
      ) {
        // Honest provenance: a "decided in code" branch must reference a real variable,
        // not a name nothing provides (else it silently never fires at runtime).
        diagnostics.push({
          code: "field_guard_unknown_reference",
          location: `transition:${transition.fromStep}->${transition.toRef}`,
          message: `field guard references "${transition.fieldRef}", which is not a declared variable.`,
        });
      } else if (slot) {
        // A field guard's reference is a slot reference too (it branches on the value).
        referencedSlotKeys.add(transition.fieldRef);
        if (transition.fieldOp && !isFieldOpCompatible(transition.fieldOp, slot.type)) {
          diagnostics.push({
            code: "field_guard_incompatible_type",
            location: `transition:${transition.fromStep}->${transition.toRef}`,
            message: `field guard "${transition.fieldOp}" cannot apply to the ${slot.type} variable "${transition.fieldRef}".`,
          });
        }
      }
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
