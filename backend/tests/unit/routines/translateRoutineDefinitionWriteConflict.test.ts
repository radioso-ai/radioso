import { describe, expect, it } from "vitest";

import { translateRoutineDefinitionWriteConflict } from "../../../src/modules/routines/public.js";
import { AppError } from "../../../src/shared/domain/errors.js";

describe("translateRoutineDefinitionWriteConflict", () => {
  it("translates a raw pg unique-violation on the name/version constraint to a domain conflict", () => {
    const error = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint: "routine_definition_agent_id_name_version_key",
    });

    const translated = translateRoutineDefinitionWriteConflict(error);

    expect(translated).toBeInstanceOf(AppError);
    expect(translated?.code).toBe("conflict");
    expect(translated?.message).toBe("A routine definition with this name and version already exists for this agent");
  });

  it("translates the repository's plain-Error update CAS miss to a domain conflict", () => {
    const translated = translateRoutineDefinitionWriteConflict(new Error("routine_definition_update_conflict:routine-1"));

    expect(translated).toBeInstanceOf(AppError);
    expect(translated?.code).toBe("conflict");
    expect(translated?.message).toBe("Routine changed while it was being edited — reload it and try again");
  });

  it("leaves an unrelated failure for the caller to translate", () => {
    const foreignKeyViolation = Object.assign(new Error("violates foreign key constraint"), { code: "23503" });

    expect(translateRoutineDefinitionWriteConflict(foreignKeyViolation)).toBeUndefined();
    expect(translateRoutineDefinitionWriteConflict(new Error("connection reset"))).toBeUndefined();
    expect(translateRoutineDefinitionWriteConflict("not an error")).toBeUndefined();
  });
});
