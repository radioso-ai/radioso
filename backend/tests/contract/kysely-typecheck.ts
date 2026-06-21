import type { Kysely } from "kysely";

import type { DB } from "../../src/shared/infra/kysely/schema.js";

// Compile-time guard (SC-003): each statement below MUST remain a type error. If the
// generated schema or Kysely ever makes one valid, its @ts-expect-error becomes unused and
// "tsc -p tsconfig.json --noEmit" fails, surfacing the regression. The tsconfig includes
// the tests directory, so this file is type-checked; vitest never runs it (not a test file).
//
// This is the guarantee raw SQL strings never gave us: a wrong column or table is caught at
// compile time, not at runtime.
export const negativeCompileChecks = (db: Kysely<DB>): void => {
  // @ts-expect-error - column does not exist on sessions
  void db.selectFrom("sessions").select(["nonexistent_column"]);

  // @ts-expect-error - table does not exist in the schema
  void db.selectFrom("nonexistent_table").selectAll();

  // @ts-expect-error - sessions.id is a string (uuid); comparing to a number is invalid
  void db.selectFrom("sessions").selectAll().where("id", "=", 123);
};
