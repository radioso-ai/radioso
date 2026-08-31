import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import type {
  CopilotRetrievalEvidence,
  CopilotRetrievalProbePort,
} from "../contracts/retrievalProbe.js";
export type { CopilotRetrievalProbePort } from "../contracts/retrievalProbe.js";
import { describeNamedAgent, requiredPageAgent, type CopilotAgentLookupPort } from "./shared.js";

const MAX_RESULTS = 10;
const MAX_CONTENT_CHARS = 1_200;

const idSchema = z.string().uuid();

export const retrievalProbeInputSchema = z.object({
  agentId: idSchema.optional(),
  agentName: z.string().trim().min(1).max(160).optional(),
  query: z.string().trim().min(1).max(2_000),
  topK: z.number().int().min(1).max(MAX_RESULTS).optional(),
  metadataFilter: z.record(z.unknown()).optional(),
}).strict();

const omissionSchema = z.object({
  field: z.enum(["results", "results.content"]),
  reason: z.enum(["array_length", "string_length"]),
  omittedCount: z.number().int().positive().optional(),
}).strict();

export const retrievalProbeOutputSchema = z.object({
  probe: z.object({
    agentId: idSchema,
    /** False means this agent answers without retrieval, whatever the results below show. */
    retrievalEnabled: z.boolean(),
    query: z.string().max(2_000),
    rewrittenQuery: z.object({
      semantic: z.string().max(2_000),
      lexical: z.string().max(2_000),
    }).strict(),
    results: z.array(z.object({
      documentId: z.string().max(160),
      chunkId: z.string().max(160),
      title: z.string().max(240),
      content: z.string().max(MAX_CONTENT_CHARS),
      score: z.number().optional(),
    }).strict()).max(MAX_RESULTS),
  }).strict(),
  omissions: z.array(omissionSchema).max(4),
}).strict();

type RetrievalProbeInput = z.infer<typeof retrievalProbeInputSchema>;
type RetrievalProbeOutput = z.infer<typeof retrievalProbeOutputSchema>;
type ProbeOmission = RetrievalProbeOutput["omissions"][number];

export interface RetrievalProbeCopilotToolDependencies {
  readonly retrievalProbe: CopilotRetrievalProbePort;
  readonly agentLookup: CopilotAgentLookupPort;
}

const DESCRIPTION = "Run one retrieval-only search with a specific agent's own retrieval settings, source scope, and skill configuration, and return the chunks it would ground on with their scores. Answers 'why was this (not) retrieved' without spending a full agent turn. Results always describe the named agent; `retrievalEnabled: false` means that agent answers without retrieval at all.";

export const createRetrievalProbeCopilotTools = (
  deps: RetrievalProbeCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor<RetrievalProbeInput, RetrievalProbeOutput>> => [{
  name: "retrieval_probe",
  shape: "probe",
  uiLabel: "Probing retrieval",
  contributingModule: "retrieval",
  dashboardSubject: { type: "agent" },
  requiredPermissions: ["workspace.retrieval.query", "workspace.agents.read"],
  description: DESCRIPTION,
  inputSchema: retrievalProbeInputSchema,
  outputSchema: retrievalProbeOutputSchema,
  createTool: (context) => ({
    name: "retrieval_probe",
    description: DESCRIPTION,
    inputSchema: retrievalProbeInputSchema,
    outputSchema: retrievalProbeOutputSchema,
    invoke: async (input) => {
      const agentId = input.agentId ?? requiredPageAgent(context.pageContext.agentId);
      const result = await deps.retrievalProbe.probe({
        workspaceId: context.workspaceId,
        accountId: context.accountId,
        operatorUserId: context.operatorUserId,
        agentId,
        query: input.query,
        ...(input.topK !== undefined ? { topK: input.topK } : {}),
        ...(input.metadataFilter ? { metadataFilter: input.metadataFilter } : {}),
      });
      const omissions: ProbeOmission[] = [];
      return retrievalProbeOutputSchema.parse({
        probe: {
          agentId: result.agentId,
          retrievalEnabled: result.retrievalEnabled,
          query: input.query,
          rewrittenQuery: result.rewrittenQuery,
          results: projectResults(result.results, omissions),
        },
        omissions,
      });
    },
  }),
  describeEntity: (input, context) => describeNamedAgent(input, context, deps.agentLookup),
  describeOutputEntity: (output) => ({ type: "agent", id: (output as RetrievalProbeOutput).probe.agentId }),
}];

const projectResults = (
  results: ReadonlyArray<CopilotRetrievalEvidence>,
  omissions: ProbeOmission[],
): RetrievalProbeOutput["probe"]["results"] => {
  if (results.length > MAX_RESULTS) {
    omissions.push({ field: "results", reason: "array_length", omittedCount: results.length - MAX_RESULTS });
  }
  let truncatedContentCount = 0;
  const projected = results.slice(0, MAX_RESULTS).map((result) => {
    const truncated = result.content.length > MAX_CONTENT_CHARS;
    if (truncated) truncatedContentCount += 1;
    return {
      documentId: result.documentId,
      chunkId: result.chunkId,
      title: result.title,
      content: truncated ? `${result.content.slice(0, MAX_CONTENT_CHARS - 1)}…` : result.content,
      ...(result.score !== undefined ? { score: result.score } : {}),
    };
  });
  if (truncatedContentCount > 0) {
    omissions.push({ field: "results.content", reason: "string_length", omittedCount: truncatedContentCount });
  }
  return projected;
};
