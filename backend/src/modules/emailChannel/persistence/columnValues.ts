// Narrowing for the email channel's enumerated text columns. Every one carries a CHECK
// constraint, so a value outside its set is schema drift worth failing loudly on.

export const readEnum = <T extends string>(value: string, allowed: readonly T[], column: string): T => {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${column} holds an unknown value: ${value}`);
  }
  return value as T;
};

export const readOptionalEnum = <T extends string>(
  value: string | null,
  allowed: readonly T[],
  column: string,
): T | null => (value === null ? null : readEnum(value, allowed, column));
