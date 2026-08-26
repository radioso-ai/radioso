import type { CopilotToolShape } from "./contracts.js";

export interface CopilotToolAnnotationHints {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
}

const annotationsByShape: Record<CopilotToolShape, CopilotToolAnnotationHints> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  // Not read-only and not idempotent, despite changing no operator-managed configuration: a probe
  // spends real model budget and records that it ran. Both hints are permissions a transport acts
  // on — read-only invites auto-running it, idempotent invites retrying it — and each such call is
  // another billed turn and another persisted row.
  probe: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  act: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  propose: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

/** Maps catalog semantics to MCP-compatible hints without depending on MCP. */
export const copilotToolAnnotationsForShape = (shape: CopilotToolShape): CopilotToolAnnotationHints => annotationsByShape[shape];
