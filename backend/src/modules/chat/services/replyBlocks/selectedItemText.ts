import { escapeXmlText } from "../../../../shared/domain/escapeXmlText.js";
import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import type { SelectedItem } from "./itemSelection.js";

/** One field on its own line: control characters and line breaks become spaces, markup is escaped. */
const field = (label: string, value: string | undefined): string[] => {
  const line = value?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line ? [`${label}: ${escapeXmlText(line)}`] : [];
};

/**
 * The picked item as the reply's prompt carries it: its fields inside one `<selected_item>`
 * block, as data, with the rule that it is the reply's subject. Text from a page or a skill's
 * result can never close the block.
 */
export const renderSelectedItem = (item: SelectedItem): string =>
  renderPromptTemplate("chat/selected-item.md", {
    item_fields: [
      ...field("title", item.title),
      ...field("subtitle", item.description),
      ...field("link", item.link),
      ...field("document", item.document?.title),
      ...field("from skill", item.skillName),
    ].join("\n"),
  });
