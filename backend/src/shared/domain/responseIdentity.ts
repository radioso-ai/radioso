// Neutral, non-identifying label shown on public chat and website embed
// surfaces when no presentable assistant/agent name is configured. Falling back
// to this instead of the internal workspace name keeps seeded defaults like
// "Default" from leaking to end users.
export const PUBLIC_ASSISTANT_FALLBACK_NAME = "Assistant";

export interface ResponseIdentity {
  name?: string;
}

export const buildResponseIdentityLines = (input: ResponseIdentity): string[] =>
  [
    input.name ? `Response identity name: ${input.name}` : null,
  ].filter((line): line is string => Boolean(line));
