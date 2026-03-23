import { applyColor } from "./support/ansi-capabilities.mjs";

const palette = {
  title: "1;33",
  accent: "36",
  brand: "1;37",
  prompt: "1;97;44",
  helper: "90",
  warning: "1;33",
  error: "1;31",
  success: "1;32",
};

export const renderHeader = (ansi) => {
  const plain = [
    "          \\  |  /",
    "           .-*-.",
    "       --- [###] ---",
    "           `-*-`",
    "          /  |  \\",
    "",
    "      .--.            .--.",
    "   .-(    ).      .-(    ).",
    "  (___.__)__)    (___.__)__)",
    "",
    "  Radioso local start",
  ];

  if (!ansi.enabled) {
    return plain.join("\n");
  }

  const sun = [
    `${applyColor("          \\\\  |  /", palette.title, ansi)}`,
    `${applyColor("           .-*-.", palette.title, ansi)}`,
    `${applyColor("       --- [###] ---", palette.title, ansi)}`,
    `${applyColor("           `-*-`", palette.title, ansi)}`,
    `${applyColor("          /  |  \\\\", palette.title, ansi)}`,
  ];
  const clouds = [
    `${applyColor("      .--.            .--.", palette.accent, ansi)}`,
    `${applyColor("   .-(    ).      .-(    ).", palette.accent, ansi)}`,
    `${applyColor("  (___.__)__)    (___.__)__)", palette.accent, ansi)}`,
  ];

  return [...sun, "", ...clouds, "", applyColor("  Radioso local start", palette.brand, ansi)].join("\n");
};

export const formatMessage = (kind, text, ansi) => {
  switch (kind) {
    case "prompt":
      return applyColor(text, palette.prompt, ansi);
    case "helper":
      return applyColor(text, palette.helper, ansi);
    case "warning":
      return applyColor(text, palette.warning, ansi);
    case "error":
      return applyColor(text, palette.error, ansi);
    case "success":
      return applyColor(text, palette.success, ansi);
    default:
      return text;
  }
};
