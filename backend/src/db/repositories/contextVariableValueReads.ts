/**
 * The context-variable repository's reads of stored values, and the value row they map, which the
 * repository's value writer returns too.
 */

import type {
  ContextValueWriterKind,
  ContextVariableScope,
  ContextVariableValue,
} from "../../modules/context-variables/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface ContextVariableValueRow {
  id: string;
  workspace_id: string;
  variable_id: string;
  scope_type: string;
  scope_id: string;
  data: unknown;
  last_modified: Date | string;
  written_by_kind: string;
  written_by_ref: string | null;
}

export const contextVariableValueColumns = [
  "id",
  "workspace_id",
  "variable_id",
  "scope_type",
  "scope_id",
  "data",
  "last_modified",
  "written_by_kind",
  "written_by_ref",
] as const;

/**
 * The scope id as a value is stored under. A conversation's id is a UUID, which Postgres writes in
 * lowercase, so an id sent in uppercase still names the stored value.
 */
export const storedScopeId = (scope: ContextVariableScope): string =>
  scope.type === "conversation" ? scope.id.toLowerCase() : scope.id;

export const mapContextVariableValueRow = (row: ContextVariableValueRow): ContextVariableValue => ({
  id: row.id,
  workspaceId: row.workspace_id,
  variableId: row.variable_id,
  scope: {
    type: row.scope_type as ContextVariableScope["type"],
    id: row.scope_id,
  },
  data: row.data,
  lastModified: new Date(row.last_modified),
  writtenBy: { kind: row.written_by_kind as ContextValueWriterKind, ref: row.written_by_ref },
});

export const readContextVariableValue = async (
  db: Db,
  variableId: string,
  scope: ContextVariableScope,
): Promise<ContextVariableValue | null> => {
  const row = await db
    .selectFrom("context_variable_values")
    .select(contextVariableValueColumns)
    .where("variable_id", "=", variableId)
    .where("scope_type", "=", scope.type)
    .where("scope_id", "=", storedScopeId(scope))
    .executeTakeFirst();
  return row ? mapContextVariableValueRow(row) : null;
};

export const readFirstScopedValue = async (
  db: Db,
  variableId: string,
  scopes: readonly ContextVariableScope[],
): Promise<ContextVariableValue | null> => {
  for (const scope of scopes) {
    const value = await readContextVariableValue(db, variableId, scope);
    if (value) {
      return value;
    }
  }
  return null;
};
