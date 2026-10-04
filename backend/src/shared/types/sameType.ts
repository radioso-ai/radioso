/**
 * `true` when `A` and `B` are the same type, `never` otherwise — for a compile-time guard that a
 * schema still describes its contract (`const matches: SameType<z.infer<typeof Schema>, Contract> = true`).
 *
 * Stricter than mutual assignability, which an added optional property or a `readonly` modifier
 * passes: the compiler compares two deferred conditional types only when their check types are
 * identical, so any drift between `A` and `B` resolves to `never`.
 */
export type SameType<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : never;
