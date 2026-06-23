// Type declarations for the JS guard script so it can be imported from typed tests.
export const ALLOWLIST: Set<string>;
export function lineHasRawSql(line: string): boolean;
export function findRawSqlViolations(srcDir: string): string[];
