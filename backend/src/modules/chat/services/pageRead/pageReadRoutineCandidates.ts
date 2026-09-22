import type { Routine, RoutineStep } from "@radioso/conversation-contract";

import type { PageReadCandidate } from "./pageReadDecision.js";

const PAGE_CONTEXT_VARIABLE = "page_context";

const bindsPageContext = (step: RoutineStep): boolean =>
  Object.values(step.inputBindings ?? {}).some((binding) =>
    binding.kind === "contextVariableRef" && binding.contextVariable === PAGE_CONTEXT_VARIABLE,
  );

// The compiler stamps `contextRefs` from `{{context.<name>}}` references in the step's
// instruction, so a chat step that reads the page declares the dependency the same way a
// skill input bound to `page_context` does.
const readsPageContext = (step: RoutineStep): boolean => {
  const contextRefs = step.metadata?.contextRefs;
  return Array.isArray(contextRefs) && contextRefs.includes(PAGE_CONTEXT_VARIABLE);
};

/** Every step that depends on the visitor's page, each as one candidate sourced from the routine. */
export const pageReadRoutineCandidates = (
  routine: Pick<Routine, "id" | "steps">,
): PageReadCandidate[] =>
  routine.steps
    .filter((step) => bindsPageContext(step) || readsPageContext(step))
    .map(() => ({
      source: { kind: "routine" as const, routineId: routine.id },
    }));
