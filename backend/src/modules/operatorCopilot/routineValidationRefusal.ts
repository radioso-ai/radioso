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
export const routineValidationRefusal = (
  message: string,
  routineId: string | null,
  diagnostics: ReadonlyArray<{ readonly code: string; readonly location: string; readonly message: string }>,
): AppError => new AppError(422, "revision_invalid", message, {
  diagnostics: diagnostics.map((diagnostic) => ({ safeDiagnostic: true, routineId, ...toSafeRoutineValidationDiagnostic(diagnostic) })),
});
