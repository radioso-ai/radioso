import { describe, expect, it } from "vitest";

import { replyBlocksCapabilityFromRequest } from "../../../../src/modules/chat/contracts/replyBlocks.js";
import { anonymousChatSchema } from "../../../../src/app/http/routes/publicChatRouteSchemas.js";
import { PRESENT_FIELD, presentHeadSchemaExtension, readPresentHead } from "../../../../src/modules/chat/services/replyBlocks/presentHead.js";
import {
  BUTTON_LABEL_MAX_LENGTH,
  buttonLabelsPromptSection,
  withButtonLabels,
} from "../../../../src/modules/chat/services/replyBlocks/presentButtonLabels.js";
import { readRecordPresentHead, recordPresentHeadSchemaExtension } from "../../../../src/modules/chat/services/replyBlocks/recordPresentHead.js";

type PresentObject = { required: string[]; properties: Record<string, { type: unknown; minLength?: number; maxLength?: number }> };

const presentOf = (extension: ReturnType<typeof presentHeadSchemaExtension>): PresentObject =>
  extension.beforeAnswer?.properties[PRESENT_FIELD] as PresentObject;

describe("button labels on the present head", () => {
  it("leaves both heads exactly as the web is offered them unless the channel draws its buttons from the reply", () => {
    expect(presentHeadSchemaExtension()).toBe(presentHeadSchemaExtension({ buttonLabels: false }));
    expect(Object.keys(presentOf(presentHeadSchemaExtension()).properties)).toEqual(["images", "caption", "selection"]);
    expect(recordPresentHeadSchemaExtension()).toBe(recordPresentHeadSchemaExtension({ buttonLabels: false }));
    expect(Object.keys(presentOf(recordPresentHeadSchemaExtension()).properties)).toEqual(["records", "fields", "caption"]);
  });

  it("asks for both labels, at most 20 characters each, the same schema on every such turn", () => {
    for (const extension of [presentHeadSchemaExtension({ buttonLabels: true }), recordPresentHeadSchemaExtension({ buttonLabels: true })]) {
      const present = presentOf(extension);
      expect(present.required).toEqual(Object.keys(present.properties));
      expect(present.properties.selectLabel).toMatchObject({ type: "string", minLength: 1, maxLength: BUTTON_LABEL_MAX_LENGTH });
      expect(present.properties.openLabel).toMatchObject({ type: "string", minLength: 1, maxLength: BUTTON_LABEL_MAX_LENGTH });
    }
    expect(presentHeadSchemaExtension({ buttonLabels: true })).toBe(presentHeadSchemaExtension({ buttonLabels: true }));
    expect(BUTTON_LABEL_MAX_LENGTH).toBe(20);
  });

  it("reads the labels the model wrote, trimmed, and drops one that is empty, too long or not text", () => {
    const head = readPresentHead({ [PRESENT_FIELD]: { images: ["m1"], caption: "Guides", selection: "single", selectLabel: " Scegli ", openLabel: "Apri la pagina" } });
    expect(head?.buttonLabels).toEqual({ select: "Scegli", open: "Apri la pagina" });

    const record = readRecordPresentHead({
      [PRESENT_FIELD]: {
        records: ["r1"],
        fields: { title: "/name", subtitle: null, image: null, link: null },
        caption: "Homes",
        selectLabel: "x".repeat(21),
        openLabel: "Ansehen",
      },
    });
    expect(record?.buttonLabels).toEqual({ open: "Ansehen" });

    expect(readPresentHead({ [PRESENT_FIELD]: { images: ["m1"], caption: "Guides", selectLabel: "", openLabel: 3 } })?.buttonLabels).toBeUndefined();
    expect(readPresentHead({ [PRESENT_FIELD]: { images: ["m1"], caption: "Guides" } })).not.toHaveProperty("buttonLabels");
  });

  it("counts a label's length in characters, so an accented or emoji label is not cut short", () => {
    const label = `Wählen 👍${"é".repeat(12)}`;
    expect(Array.from(label).length).toBe(20);
    expect(label.length).toBe(21);
    expect(readPresentHead({ [PRESENT_FIELD]: { images: ["m1"], caption: "c", selectLabel: label, openLabel: "Öffnen" } })?.buttonLabels?.select).toBe(label);
  });

  it("puts the labels on the presented blocks only when there are any", () => {
    const block = { type: "item_list" as const, id: "b1", layout: "carousel" as const, selection: "single" as const, caption: "c", items: [] };
    expect(withButtonLabels([block], { select: "Scegli" })).toEqual([{ ...block, buttonLabels: { select: "Scegli" } }]);
    expect(withButtonLabels([block], undefined)).toEqual([block]);
    expect(withButtonLabels([block], {})).toEqual([block]);
  });

  it("asks for the labels in the conversation's language in its own prompt section", () => {
    const section = buttonLabelsPromptSection();
    expect(section).toContain("selectLabel");
    expect(section).toContain("openLabel");
    expect(section).toContain("20");
  });

  it("is never declared over HTTP: the request schema drops it and the capability keeps only what a channel adapter declares", () => {
    const parsed = anonymousChatSchema.parse({
      message: "hi",
      clientContextCapabilities: { "reply.blocks": { item_list: { layouts: ["carousel"], buttonLabels: true } } },
    });
    const declared = parsed.clientContextCapabilities?.["reply.blocks"];
    expect(replyBlocksCapabilityFromRequest(declared)).toEqual({ item_list: { layouts: ["carousel"] } });
    expect(replyBlocksCapabilityFromRequest({ item_list: { layouts: ["carousel", "list"], buttonLabels: true } })).toEqual({
      item_list: { layouts: ["carousel", "list"], buttonLabels: true },
    });
  });
});
