import { describe, expect, it } from "vitest";

import { legacyRowsToSingleModelVectorMap } from "../../../src/modules/retrieval/services/senseGroupingService.js";

describe("legacy sense embedding fallback", () => {
  it("returns vectors only when every parsed row has one known model", () => {
    expect(legacyRowsToSingleModelVectorMap([
      { id: "first", embedding_text: "[1,0,0]", embedding_model: "model-a" },
      { id: "second", embedding_text: "[0,1,0]", embedding_model: "model-a" },
    ])).toEqual(new Map([
      ["first", [1, 0, 0]],
      ["second", [0, 1, 0]],
    ]));

    expect(legacyRowsToSingleModelVectorMap([
      { id: "first", embedding_text: "[1,0,0]", embedding_model: "model-a" },
      { id: "second", embedding_text: "[0,1,0]", embedding_model: "model-b" },
    ])).toEqual(new Map());

    expect(legacyRowsToSingleModelVectorMap([
      { id: "first", embedding_text: "[1,0,0]", embedding_model: "model-a" },
      { id: "second", embedding_text: "[0,1,0]", embedding_model: null },
    ])).toEqual(new Map());
  });
});
