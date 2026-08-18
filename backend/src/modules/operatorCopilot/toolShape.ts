import type { CopilotToolShape } from "./contracts.js";

export interface CopilotToolAnnotationHints {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
}

const annotationsByShape: Record<CopilotToolShape, CopilotToolAnnotationHints> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  probe: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  act: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  propose: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

/** Maps catalog semantics to MCP-compatible hints without depending on MCP. */
export const copilotToolAnnotationsForShape = (shape: CopilotToolShape): CopilotToolAnnotationHints => annotationsByShape[shape];
