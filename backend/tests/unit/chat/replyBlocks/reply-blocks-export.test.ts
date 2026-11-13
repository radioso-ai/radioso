import { describe, expect, it } from "vitest";

import { replyBlocksForExport } from "../../../../src/modules/chat/contracts/replyBlocks.js";

const stored = {
  type: "item_list",
  id: "b1",
  layout: "carousel",
  selection: "none",
  caption: "Flats in Mitte",
  origin: { kind: "skill_result", skillName: "search_listings" },
  items: [
    {
      key: "/structuredContent/0",
      title: "Loft on Torstrasse",
      description: "Mitte",
      image: { imageId: "0f6c1e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b", width: 640, height: 480, alt: "Loft on Torstrasse" },
      actions: [{ type: "open", url: "https://homes.example/listings/loft" }],
    },
    { key: "/structuredContent/1", title: "Studio", actions: [] },
  ],
};

describe("reply blocks in a data-subject export", () => {
  it("carries each card the subject was shown: its title, subtitle, link and picture id", () => {
    expect(replyBlocksForExport({ blocks: [stored] })).toEqual([{
      id: "b1",
      layout: "carousel",
      caption: "Flats in Mitte",
      items: [
        { title: "Loft on Torstrasse", description: "Mitte", link: "https://homes.example/listings/loft", imageId: "0f6c1e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b" },
        { title: "Studio", description: null, link: null, imageId: null },
      ],
    }]);
  });

  it("carries nothing for a message with no blocks, or blocks that do not read back", () => {
    expect(replyBlocksForExport({})).toBeNull();
    expect(replyBlocksForExport(null)).toBeNull();
    expect(replyBlocksForExport({ blocks: [] })).toBeNull();
    expect(replyBlocksForExport({ blocks: [{ type: "item_list" }] })).toBeNull();
  });
});
