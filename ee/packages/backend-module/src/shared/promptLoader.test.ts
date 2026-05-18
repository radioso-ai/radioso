import { describe, expect, it } from "vitest";

import {
  getPromptSection,
  loadPromptTemplate,
  renderPromptSection,
  renderPromptTemplate,
} from "./promptLoader.js";

describe("promptLoader", () => {
  it("loads a flat single-section prompt and substitutes variables", () => {
    const template = loadPromptTemplate("humanContact/intake-intent-check.md");
    const rendered = renderPromptTemplate(template, {
      skill_name: "human_contact.request",
      skill_description: "request follow-up",
      intent_description: "user wants a human",
      intent_examples: "[\"talk to support\"]",
      user_message: "I need help.",
    });
    expect(rendered).toContain("Skill name: human_contact.request");
    expect(rendered).toContain("User message: I need help.");
    expect(rendered).not.toContain("{{");
  });

  it("returns a named section from a multi-section prompt", () => {
    const section = getPromptSection("humanContact/intake-answer.md", "kind.submitted");
    expect(section).toContain("Warmly confirm");
    expect(section).not.toContain("---");
  });

  it("renders a section with placeholder substitution", () => {
    const rendered = renderPromptSection("humanContact/intake-answer.md", "kind.missing", {
      field_display_name: "email address",
    });
    expect(rendered).toContain("\"email address\"");
    expect(rendered).not.toContain("{{");
  });

  it("throws a descriptive error when a section is missing", () => {
    expect(() => getPromptSection("humanContact/intake-answer.md", "kind.unknown")).toThrow(
      /Missing prompt section "kind.unknown"/,
    );
  });

  it("throws when a placeholder is left unfilled", () => {
    expect(() =>
      renderPromptTemplate("hello {{name}}", {}),
    ).toThrow(/Missing prompt variable "name"/);
  });
});
