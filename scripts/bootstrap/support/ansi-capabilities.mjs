const truthy = new Set(["1", "true", "yes"]);

export const detectAnsiSupport = (env = process.env, stdout = process.stdout) => {
  const noColor = env.NO_COLOR !== undefined || env.TERM === "dumb";
  const forceColor = truthy.has(String(env.FORCE_COLOR ?? "").toLowerCase());
  const isTTY = Boolean(stdout?.isTTY);
  const width = Number(stdout?.columns ?? env.COLUMNS ?? 80);

  if (!isTTY && !forceColor) {
    return { enabled: false, level: "none", width };
  }

  if (noColor && !forceColor) {
    return { enabled: false, level: "none", width };
  }

  const termProgram = String(env.TERM_PROGRAM ?? "").toLowerCase();
  const term = String(env.TERM ?? "").toLowerCase();
  const level =
    forceColor || term.includes("256") || termProgram.includes("iterm")
      ? "full"
      : "basic";

  return { enabled: true, level, width };
};

export const applyColor = (text, code, ansi = detectAnsiSupport()) => {
  if (!ansi.enabled) {
    return text;
  }

  return `\u001b[${code}m${text}\u001b[0m`;
};
