/**
 * The manifest this package validates is pure JSON: objects, arrays, and
 * scalars, never a function or a class instance. `DeepReadonly` and
 * `deepFreeze` only have to handle those three shapes, recursively, so a
 * value admission hands out cannot be mutated through a nested array or
 * object either — only the top level a plain `Readonly<T>` would have caught.
 */
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** Freezes `value` and, recursively, every array and plain object it contains. */
export const deepFreeze = <T>(value: T): T => {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value);
  }
  return value;
};
