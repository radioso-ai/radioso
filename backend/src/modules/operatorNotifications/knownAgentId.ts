import { z } from "zod";

const agentIdSchema = z.string().uuid();

/** Some notices name their agent "unknown" when the conversation has none; that is no agent. */
export const knownAgentId = (agentId: string | null): string | null =>
  agentId !== null && agentIdSchema.safeParse(agentId).success ? agentId : null;
