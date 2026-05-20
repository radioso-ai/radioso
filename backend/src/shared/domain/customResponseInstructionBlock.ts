const CUSTOM_RESPONSE_INSTRUCTIONS_TAG = "custom_response_instructions";

export function renderCustomResponseInstructionBlock(customInstruction?: string): string | null {
  if (!customInstruction) {
    return null;
  }

  const sanitized = customInstruction.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim();
  if (!sanitized) {
    return null;
  }

  return [
    "Configured response instructions:",
    `<${CUSTOM_RESPONSE_INSTRUCTIONS_TAG}>`,
    escapeXmlText(sanitized),
    `</${CUSTOM_RESPONSE_INSTRUCTIONS_TAG}>`,
  ].join("\n");
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
