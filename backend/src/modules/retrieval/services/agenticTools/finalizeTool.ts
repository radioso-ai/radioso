import { z } from "zod";

import type { AgentTool } from "../../../../shared/agent-runtime/index.js";
import type { ChunkRegistry } from "./chunkRegistry.js";

export interface FinalizedSelection {
  readonly chunkIds: ReadonlyArray<string>;
  readonly rationale: string | null;
}

export interface FinalizeToolDeps {
  readonly registry: ChunkRegistry;
  readonly onFinalized: (selection: FinalizedSelection) => void;
}

const inputSchema = z.object({
  chunkIds: z.array(z.string().min(1)).max(20),
  rationale: z.string().max(2000).optional(),
});

const outputSchema = z.union([
  z.object({
    accepted: z.literal(true),
    chunkIds: z.array(z.string()),
  }),
  z.object({
    accepted: z.literal(false),
    error: z.literal("unknown_chunks"),
    unknownChunkIds: z.array(z.string()),
  }),
]);

type FinalizeInput = z.infer<typeof inputSchema>;
type FinalizeOutput = z.infer<typeof outputSchema>;

/**
 * Terminal pseudo-tool. The model calls finalize when it has reached a
 * conclusion: either it has gathered enough evidence to ground the answer, or
 * it has explicitly determined that the workspace lacks supporting evidence.
 *
 * - Non-empty `chunkIds`: those chunks (which must have been surfaced via
 *   search first) ground the answer. The rationale describes why.
 * - Empty `chunkIds`: an explicit "no-evidence" signal. The rationale should
 *   say so (e.g. `"insufficient_evidence"`). The pipeline returns zero
 *   selected chunks and does NOT fall back to the agent's last surfaced
 *   results — finalizing with an empty selection is honest and final.
 *
 * The selected chunk ids plus an optional structured rationale flow to the
 * assistant layer via `onFinalized`; the rationale is NOT a user-facing
 * answer (see FR-024a in spec 065). The model is expected to call finalize
 * and then emit a brief final message with no further tool calls so the
 * runtime terminates cleanly.
 */
export const createFinalizeTool = (deps: FinalizeToolDeps): AgentTool<FinalizeInput, FinalizeOutput> => ({
  name: "finalize",
  description:
    "Signal that the agent has reached a conclusion. Provide the chunk ids that should ground the answer (or an empty array if there is no supporting evidence) plus a brief rationale. Do not include a natural-language answer; the assistant layer synthesizes the final response.",
  inputSchema,
  outputSchema,
  async invoke(input) {
    // Dedup while preserving first-seen order. The model may repeat a chunk id;
    // the deterministic pipeline dedups its candidates, so the agentic path must
    // too — otherwise a repeated id yields duplicate contexts and citations.
    const chunkIds = [...new Set(input.chunkIds)];
    const unknownChunkIds = chunkIds.filter((id) => !deps.registry.has(id));
    if (unknownChunkIds.length > 0) {
      return {
        accepted: false as const,
        error: "unknown_chunks" as const,
        unknownChunkIds,
      };
    }
    const rationale = input.rationale?.trim() ?? "";
    deps.onFinalized({
      chunkIds,
      rationale: rationale.length > 0 ? rationale : null,
    });
    return {
      accepted: true as const,
      chunkIds,
    };
  },
});
