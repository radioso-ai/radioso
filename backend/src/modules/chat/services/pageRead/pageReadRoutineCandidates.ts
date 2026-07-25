import type { Routine } from "@radioso/conversation-contract";

import type { PageReadCandidate } from "./pageReadDecision.js";

export const pageReadRoutineCandidates = (
  routine: Pick<Routine, "id" | "steps">,
): PageReadCandidate[] =>
  routine.steps.flatMap((step) =>
    Object.values(step.inputBindings ?? {})
      .filter((binding) =>
        binding.kind === "contextVariableRef" &&
        binding.contextVariable === "page_context",
      )
      .map(() => ({
        source: { kind: "routine" as const, routineId: routine.id },
      })),
  );
