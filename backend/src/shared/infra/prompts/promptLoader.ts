import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

const candidatePromptDirectories = [
  process.env.RADIOSO_PROMPTS_DIR,
  path.resolve(process.cwd(), "prompts"),
  path.resolve(moduleDirectory, "../../../../prompts"),
  path.resolve(moduleDirectory, "../../../../../backend/prompts"),
].filter((value): value is string => typeof value === "string" && value.length > 0);

const promptCache = new Map<string, string>();

const resolvePromptsDirectory = (): string => {
  for (const candidate of candidatePromptDirectories) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Prompt directory not found. Checked: ${candidatePromptDirectories.join(", ") || "(none)"}`,
  );
};

export const loadPromptTemplate = (relativePath: string): string => {
  const cached = promptCache.get(relativePath);
  if (cached) {
    return cached;
  }

  const templatePath = path.join(resolvePromptsDirectory(), relativePath);
  const template = readFileSync(templatePath, "utf8").trimEnd();
  promptCache.set(relativePath, template);
  return template;
};

export const renderPromptTemplate = (
  relativePath: string,
  variables: Record<string, string>,
): string => {
  const template = loadPromptTemplate(relativePath);

  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    if (!(key in variables)) {
      throw new Error(`Missing prompt variable "${key}" for template ${relativePath}`);
    }

    return variables[key] ?? "";
  });
};
