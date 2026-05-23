const splitConfiguredSinks = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((sink) => sink.trim().toLowerCase())
    .filter(Boolean);

export const parseConfiguredSinks = (
  value: string | undefined,
  input: {
    envName: string;
    supportedSinks: readonly string[];
  },
): Set<string> => {
  const supported = new Set(input.supportedSinks.map((sink) => sink.toLowerCase()));
  const configured = splitConfiguredSinks(value);
  const unsupported = configured.filter((sink) => !supported.has(sink));

  if (unsupported.length > 0) {
    throw new Error(
      `${input.envName} contains unsupported sink(s): ${unsupported.join(", ")}. Supported sinks: ${
        input.supportedSinks.join(", ")
      }`,
    );
  }

  return new Set(configured);
};
