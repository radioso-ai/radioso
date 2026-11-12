import { toSafeRoutineValidationDiagnostic } from "../routines/public.js";
import { AppError } from "../../shared/domain/errors.js";

/**
 * The canonical "this routine cannot be served" refusal for a copilot/MCP caller. A 422
 * `revision_invalid` AppError is the shape `mcpApplicationService.ts`'s `CALLER_REJECTION_422_CODES`
 * already recognizes as caller-correctable, translating it into an `invalid_arguments` refusal
 * instead of a fake outage. Its details carry only the routines owner's safe diagnostic mapping,
 * never a diagnostic's raw `message` - which can embed authored content such as a slot name typed
 * by the operator. Both `prepare_routine_structure` and the routine-edit proposal adapter route a
 * blocking validation failure through this one shape so the boundary sees one message class for
 * this failure, not one invented per caller.
 */
type RoutineDiagnostic = { readonly code: string; readonly location: string; readonly message: string };

/**
 * Identifies a diagnostic across an edit. Locations address stable ids, except routine-level ones,
 * which carry the routine's name — so renaming a routine would otherwise look like it introduced
 * every routine-level diagnostic the routine already had, and block the rename.
 */
const diagnosticIdentity = (diagnostic: RoutineDiagnostic): string =>
  `${diagnostic.code}@${diagnostic.location.startsWith("routine:") ? "routine:" : diagnostic.location}`;

/**
 * The diagnostics an edit adds: those `after` reports that `before` did not. Only these block a
 * copilot edit. A routine that already fails validation must stay editable, or the one change that
 * would fix it (such as the step split a consent needs) cannot be proposed.
 */
export const diagnosticsIntroducedBy = <T extends RoutineDiagnostic>(
  before: ReadonlyArray<RoutineDiagnostic>,
  after: ReadonlyArray<T>,
): T[] => {
  const carried = new Set(before.map(diagnosticIdentity));
  return after.filter((diagnostic) => !carried.has(diagnosticIdentity(diagnostic)));
};

export const routineValidationRefusal = (
  message: string,
  routineId: string | null,
  diagnostics: ReadonlyArray<{ readonly code: string; readonly location: string; readonly message: string }>,
): AppError => new AppError(422, "revision_invalid", message, {
  diagnostics: diagnostics.map((diagnostic) => ({ safeDiagnostic: true, routineId, ...toSafeRoutineValidationDiagnostic(diagnostic) })),
});
