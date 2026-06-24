export type ContextVariableSnapshot = Record<string, unknown>;

export const redactSnapshot = (entries: ContextVariableSnapshot): ContextVariableSnapshot => ({
  ...entries,
});
