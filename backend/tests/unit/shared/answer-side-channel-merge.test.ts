import { describe, expect, it } from "vitest";

import {
  mergeAnswerSchemaExtensions,
  type AnswerSchemaExtension,
} from "../../../src/shared/domain/answerSideChannel.js";
import { buildGroundedAnswerResponseFormat } from "../../../src/modules/chat/services/groundedAnswerEnvelope.js";

const adherence: AnswerSchemaExtension = {
  beforeAnswer: { properties: { adherencePlan: { type: "array" } }, required: ["adherencePlan"] },
  properties: { adherence: { type: "array" } },
  required: ["adherence"],
};

const present: AnswerSchemaExtension = {
  properties: { present: { type: "object" } },
  required: ["present"],
};

describe("mergeAnswerSchemaExtensions", () => {
  it("returns the one extension it is given, as the same object", () => {
    expect(mergeAnswerSchemaExtensions(adherence, null)).toBe(adherence);
    expect(mergeAnswerSchemaExtensions(null, present)).toBe(present);
    expect(mergeAnswerSchemaExtensions(undefined, undefined)).toBeNull();
  });

  it("keeps adherence first and adds present after it", () => {
    const merged = mergeAnswerSchemaExtensions(adherence, present);

    expect(merged).toEqual({
      beforeAnswer: { properties: { adherencePlan: { type: "array" } }, required: ["adherencePlan"] },
      properties: { adherence: { type: "array" }, present: { type: "object" } },
      required: ["adherence", "present"],
    });
    expect(Object.keys(merged?.properties ?? {})).toEqual(["adherence", "present"]);
  });

  it("puts present after answer and after adherence in the grounded envelope", () => {
    const format = buildGroundedAnswerResponseFormat(mergeAnswerSchemaExtensions(adherence, present));
    const keys = Object.keys(format.schema.properties as Record<string, unknown>);

    expect(keys.indexOf("adherencePlan")).toBeLessThan(keys.indexOf("answer"));
    expect(keys.indexOf("answer")).toBeLessThan(keys.indexOf("adherence"));
    expect(keys.at(-1)).toBe("present");
    expect((format.schema.required as string[]).at(-1)).toBe("present");
  });
});
