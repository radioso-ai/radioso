import type { RoutineInvocation } from "./routineInvocationValidator.js";

/**
 * The user-authored text a tool call is recorded as: `toolName {json}`, values
 * verbatim, exactly as if a person had typed them. Structural and
 * language-neutral, so the LLM-visible history reads the same as chat; any
 * redaction of sensitive values is an operator-view concern, never applied here.
 */
export const renderRoutineInvocation = (invocation: Pick<RoutineInvocation, "toolName" | "input">): string =>
  `${invocation.toolName} ${JSON.stringify(invocation.input)}`;
