import { describe, expect, it } from "vitest";

import { cutReplyContent } from "../../src/modules/chat/services/cutReplyMessage.js";

describe("the stored part of a reply cut off mid-stream", () => {
  it("keeps the markdown and drops the composer's citation markers, as every stored answer does", () => {
    expect(cutReplyContent("We open at **nine** on weekdays [[1]]. Saturdays at ten.[[2]] [?] ")).toBe("We open at **nine** on weekdays. Saturdays at ten.");
    expect(cutReplyContent("Our plans:\n- Basic is free.\n- Pro is `PRO-10`.\n")).toBe("Our plans:\n- Basic is free.\n- Pro is `PRO-10`.");
  });

  it("removes a delimiter the cut left open, so the part renders as its words", () => {
    expect(cutReplyContent("[See the hours. ")).toBe("See the hours.");
    expect(cutReplyContent("Done. **Bold start. ")).toBe("Done. Bold start.");
    expect(cutReplyContent("Done. *Leaning start. ")).toBe("Done. Leaning start.");
    expect(cutReplyContent("Done. _Leaning start. ")).toBe("Done. Leaning start.");
    expect(cutReplyContent("Done. ***Both start. ")).toBe("Done. Both start.");
    expect(cutReplyContent("Run `npm i. ")).toBe("Run npm i.");
    expect(cutReplyContent("Run ``npm `i`. ")).toBe("Run npm `i`.");
  });

  it("keeps every construct the part holds whole, and delimiters that are text", () => {
    for (const whole of [
      "See [the hours](https://example.com/h_x).",
      "It is *really* open.",
      "It is _really_ open.",
      "It is ***really*** open.",
      "It is **open** (*daily*).",
      "Type ``a `quoted` word`` or `b`.",
      "Use my_setting, 5*3 and 2 * 3.",
    ]) {
      expect(cutReplyContent(whole)).toBe(whole);
    }
  });

  it("is empty when the part held nothing but markers", () => {
    expect(cutReplyContent(" [[1]] ")).toBe("");
  });
});
