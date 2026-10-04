import { describe, expect, it } from "vitest";

import type { SameType } from "../../../src/shared/types/sameType.js";

// Type-level checks: each `@ts-expect-error` below is a drift `SameType` must refuse, so the backend
// typecheck fails if the helper ever lets one through. The runtime assertions only keep vitest honest.

interface Entry {
  id: string;
  label: string | null;
  decision: { optionId: string } | null;
}

describe("SameType", () => {
  it("accepts a shape written out again, and an Omit of the same contract", () => {
    const restated: SameType<Entry, { id: string; label: string | null; decision: { optionId: string } | null }> = true;
    const omitted: SameType<Omit<Entry, "id">, { label: string | null; decision: { optionId: string } | null }> = true;

    expect([restated, omitted]).toEqual([true, true]);
  });

  it("refuses the drift mutual assignability lets through", () => {
    // @ts-expect-error an added optional property: each side is still assignable to the other
    const addedOptional: SameType<Entry, Entry & { note?: string }> = true;
    // @ts-expect-error the same, written as one object type
    const addedOptionalInline: SameType<Entry, { id: string; label: string | null; decision: { optionId: string } | null; note?: string }> = true;
    // @ts-expect-error a nested object gaining an optional property
    const nestedOptional: SameType<Entry, { id: string; label: string | null; decision: { optionId: string; reason?: string } | null }> = true;

    expect([addedOptional, addedOptionalInline, nestedOptional]).toHaveLength(3);
  });

  it("refuses a dropped property, a changed type, and a lost null", () => {
    // @ts-expect-error a dropped property
    const dropped: SameType<Entry, { id: string; label: string | null }> = true;
    // @ts-expect-error a changed type
    const changed: SameType<Entry, { id: number; label: string | null; decision: { optionId: string } | null }> = true;
    // @ts-expect-error a property no longer nullable
    const notNull: SameType<Entry, { id: string; label: string; decision: { optionId: string } | null }> = true;

    expect([dropped, changed, notNull]).toHaveLength(3);
  });
});
