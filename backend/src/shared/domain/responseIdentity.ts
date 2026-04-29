export interface ResponseIdentity {
  name?: string;
}

export const buildResponseIdentityLines = (input: ResponseIdentity): string[] =>
  [
    input.name ? `Response identity name: ${input.name}` : null,
  ].filter((line): line is string => Boolean(line));
