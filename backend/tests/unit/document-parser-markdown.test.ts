import { detectDocumentType, parseDocument, SUPPORTED_DOCUMENT_TYPES } from "@radioso/document-parser";
import { describe, expect, it } from "vitest";

describe("markdown document parser", () => {
  it("lists markdown among the supported document types", () => {
    expect(SUPPORTED_DOCUMENT_TYPES).toContain("md");
  });

  it("detects markdown by extension and by mime type", () => {
    expect(detectDocumentType({ filename: "guide.md" })).toBe("md");
    expect(detectDocumentType({ filename: "guide.markdown" })).toBe("md");
    expect(detectDocumentType({ filename: "guide", mimeType: "text/markdown" })).toBe("md");
  });

  it("preserves markdown structure in both text and markdown output", async () => {
    const source = "# Shipping FAQ\n\n- First\n- Second\n";
    const parsed = await parseDocument({
      buffer: Buffer.from(source, "utf8"),
      filename: "shipping-faq.md",
      mimeType: "text/markdown",
    });

    expect(parsed.fileType).toBe("md");
    expect(parsed.markdown).toContain("# Shipping FAQ");
    expect(parsed.markdown).toContain("- First");
    expect(parsed.text).toContain("Shipping FAQ");
  });
});
