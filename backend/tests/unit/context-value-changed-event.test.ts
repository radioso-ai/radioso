import { describe, expect, it } from "vitest";

import {
  contextValueChangedEvent,
  contextValueChanged,
} from "../../src/modules/context-variables/contextValueChangedEvent.js";
import { workspaceEventDataSchema } from "../../src/shared/domain/workspaceEventLog.js";

const topic = { id: "0b5f4c1e-2a3d-4e6f-8a9b-1c2d3e4f5a6b", name: "topic", valueType: "enum" as const, sensitivity: "normal" as const };
const careNeed = { id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", name: "care_need", valueType: "enum" as const, sensitivity: "sensitive" as const };
const subject = {
  conversationId: "6f1c1f9e-5d0b-4d55-9a53-2b7f3f1b7a10",
  agentId: null,
  channel: "website_embed",
  callerKind: "human",
  visitorId: null,
};

describe("the context_value.changed event a writer records (#1884)", () => {
  it("names the attribute by id and name, its type, the conversation scope, the stored value and the kind of writer", () => {
    const draft = contextValueChangedEvent({
      workspaceId: "w-1",
      conversationId: subject.conversationId,
      variable: topic,
      value: "billing",
      writtenBy: { kind: "operator", ref: "user-1" },
      routineId: null,
    });

    expect(draft).toEqual({
      type: "context_value.changed",
      workspaceId: "w-1",
      conversationId: subject.conversationId,
      detail: {
        variableId: topic.id,
        variable: "topic",
        valueType: "enum",
        scope: "conversation",
        value: "billing",
        redacted: false,
        writtenBy: "operator",
        routineId: null,
      },
    });
    expect(() => workspaceEventDataSchema("context_value.changed").strict().parse({ ...subject, ...draft.detail })).not.toThrow();
  });

  it("names a person value a routine saved in the conversation by its scope, never by the person's key", () => {
    const draft = contextValueChangedEvent({
      workspaceId: "w-1",
      conversationId: subject.conversationId,
      scope: "whatsapp_contact",
      variable: { ...topic, name: "party_size", valueType: "number" },
      value: 4,
      writtenBy: { kind: "routine", ref: `routine-1:execution-1@${subject.conversationId}` },
      routineId: "routine-1",
    });

    expect(draft.conversationId).toBe(subject.conversationId);
    expect(draft.detail).toMatchObject({ scope: "whatsapp_contact", value: 4, writtenBy: "routine", routineId: "routine-1" });
    expect(() => workspaceEventDataSchema("context_value.changed").strict().parse({ ...subject, ...draft.detail })).not.toThrow();
    expect(workspaceEventDataSchema("context_value.changed").safeParse({ ...subject, ...draft.detail, scope: "session" }).success).toBe(false);
  });

  it("requires the value, null when cleared or Private, so a payload that leaves it out is not one", () => {
    const { value: _value, ...withoutValue } = contextValueChangedEvent({
      workspaceId: "w-1",
      conversationId: subject.conversationId,
      variable: topic,
      value: null,
      writtenBy: { kind: "operator", ref: "user-1" },
      routineId: null,
    }).detail;

    expect(() => workspaceEventDataSchema("context_value.changed").parse({ ...subject, ...withoutValue, value: null })).not.toThrow();
    expect(() => workspaceEventDataSchema("context_value.changed").parse({ ...subject, ...withoutValue })).toThrow();
  });

  it("records a cleared value as null", () => {
    const draft = contextValueChangedEvent({
      workspaceId: "w-1",
      conversationId: subject.conversationId,
      variable: topic,
      value: null,
      writtenBy: { kind: "classifier", ref: "context-classification/1" },
      routineId: null,
    });

    expect(draft.detail).toMatchObject({ value: null, redacted: false, writtenBy: "classifier" });
  });

  it("never carries a Private attribute's value, set or cleared", () => {
    const set = contextValueChangedEvent({
      workspaceId: "w-1",
      conversationId: subject.conversationId,
      variable: careNeed,
      value: "dental",
      writtenBy: { kind: "api", ref: "credential-1" },
      routineId: null,
    });

    expect(set.detail).toMatchObject({ value: null, redacted: true });
    expect(JSON.stringify(set)).not.toContain("dental");
  });

  it("names the routine that wrote a value as the writer says, never read out of its reference", () => {
    const draft = contextValueChangedEvent({
      workspaceId: "w-1",
      conversationId: subject.conversationId,
      variable: topic,
      value: "billing",
      writtenBy: { kind: "routine", ref: "routine:legacy:booking:v2:execution-1" },
      routineId: "routine:legacy:booking:v2",
    });

    expect(draft.detail.routineId).toBe("routine:legacy:booking:v2");
  });

  it("names the routine that wrote a value, and never the writer's other references", () => {
    const routine = contextValueChangedEvent({
      workspaceId: "w-1",
      conversationId: subject.conversationId,
      variable: topic,
      value: "billing",
      writtenBy: { kind: "routine", ref: "booking:7d0c9a3e-1f9b-4a8e-9a43-5b1d2f3c4e5f" },
      routineId: "booking",
    });
    const api = contextValueChangedEvent({
      workspaceId: "w-1",
      conversationId: subject.conversationId,
      variable: topic,
      value: "billing",
      writtenBy: { kind: "api", ref: "credential-1" },
      routineId: null,
    });

    expect(routine.detail).toMatchObject({ writtenBy: "routine", routineId: "booking" });
    expect(api.detail).toMatchObject({ writtenBy: "api", routineId: null });
    expect(JSON.stringify(api)).not.toContain("credential-1");
  });
});

describe("whether a write changed the stored value", () => {
  it("compares the value alone, not who wrote it", () => {
    expect(contextValueChanged(undefined, "billing")).toBe(true);
    expect(contextValueChanged("billing", undefined)).toBe(true);
    expect(contextValueChanged("billing", "shipping")).toBe(true);
    expect(contextValueChanged("billing", "billing")).toBe(false);
    expect(contextValueChanged(undefined, undefined)).toBe(false);
  });

  it("compares a JSON value by its content, whatever its key order", () => {
    expect(contextValueChanged({ plan: "pro", seats: 3 }, { seats: 3, plan: "pro" })).toBe(false);
    expect(contextValueChanged({ plan: "pro" }, { plan: "team" })).toBe(true);
  });
});
