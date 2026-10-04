import type { RoutineInvocation } from "./routineInvocationValidator.js";

/**
 * The user-authored text a tool call is recorded as: `toolName {json}`, values
 * verbatim, exactly as if a person had typed them. Structural and
 * language-neutral, so the LLM-visible history reads the same as chat and an
 * operator sees the call the way they see any typed message.
 */
export const renderRoutineInvocation = (invocation: Pick<RoutineInvocation, "toolName" | "input">): string =>
  `${invocation.toolName} ${JSON.stringify(invocation.input)}`;
