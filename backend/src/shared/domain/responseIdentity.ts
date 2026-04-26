export interface ResponseIdentity {
  name?: string;
  role?: string;
}

export const buildResponseIdentityLines = (input: ResponseIdentity): string[] =>
  [
    input.name ? `Response identity name: ${input.name}` : null,
    input.role ? `Response identity role: ${input.role}` : null,
  ].filter((line): line is string => Boolean(line));
