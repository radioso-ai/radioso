import type { ContextVariableValueType } from "./domain.js";

export const isValueCompatibleWithType = (
  valueType: ContextVariableValueType,
  value: unknown,
): boolean => valueType === "json" || typeof value === "string";
