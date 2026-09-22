// The descriptor is routine data. It arrives through the routines module's published port,
// type-only: discovery renders what a descriptor says and never learns what a routine is.
import type { AgentToolDescriptor } from "../../routines/public.js";

export type { AgentToolDescriptor };

/**
 * Everything the public documents may say about one agent, and nothing else. There is no
 * workspace id, agent id, revision id, or credential on this shape: a card is served to
 * anyone who asks, so the safe boundary is a profile that cannot carry an internal fact
 * rather than renderers trusted to leave one out.
 */
export interface AgentPublicProfile {
  /** `ag_` + 22 base64url characters. The only identifier a card carries. */
  publicId: string;
  name: string;
  /** Operator-authored public description; null when nobody has written one. */
  description: string | null;
  /** Where a calling agent connects. Injected configuration, never derived from a request. */
  mcpEndpointUrl: string;
  /** The connect guide; null when the deployment publishes no docs URL. */
  documentationUrl: string | null;
  /** True when the agent takes callers with no credential. */
  walkInEnabled: boolean;
  tools: readonly AgentToolDescriptor[];
  /** The published release the documents describe, as a version string. */
  revisionVersion: string;
  /** When that release was published, ISO-8601. */
  revisionPublishedAt: string;
}

/**
 * Resolves a public id to the profile its documents render from. Returns null for every
 * reason a caller is not entitled to a document — unknown id, card switched off, agent
 * unpublished, agent deleted — so the routes answer all four identically.
 */
export interface AgentPublicProfilePort {
  load(publicId: string): Promise<AgentPublicProfile | null>;
}
