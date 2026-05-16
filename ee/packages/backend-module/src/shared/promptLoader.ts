import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

// The prompts directory lives at the package root in both dev (src/) and built (dist/) layouts,
// because `src/shared/` and `dist/shared/` are the same depth from the package root.
const PROMPTS_ROOT = path.resolve(moduleDirectory, "../../prompts");

const templateCache = new Map<string, string>();
const sectionCache = new Map<string, Map<string, string>>();
const shouldBypassPromptCache = process.env.NODE_ENV === "development";

const SECTION_LINE_PATTERN = /^---\s*([a-zA-Z0-9_.-]+)\s*---\s*$/;

export const loadPromptTemplate = (relativePath: string): string => {
  if (!shouldBypassPromptCache) {
    const cached = templateCache.get(relativePath);
    if (cached) {
      return cached;
    }
  }
  const absolutePath = path.join(PROMPTS_ROOT, relativePath);
  const template = readFileSync(absolutePath, "utf8").trimEnd();
  if (!shouldBypassPromptCache) {
    templateCache.set(relativePath, template);
  }
  return template;
};

const parseSections = (template: string): Map<string, string> => {
  const sections = new Map<string, string>();
  const lines = template.split("\n");
  let currentName: string | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    if (currentName !== null) {
      sections.set(currentName, currentLines.join("\n").trim());
    }
  };
  for (const line of lines) {
    const match = SECTION_LINE_PATTERN.exec(line);
    if (match) {
      flush();
      currentName = match[1];
      currentLines = [];
    } else if (currentName !== null) {
      currentLines.push(line);
    }
  }
  flush();
  return sections;
};

export const getPromptSection = (relativePath: string, sectionName: string): string => {
  const cached = shouldBypassPromptCache ? undefined : sectionCache.get(relativePath);
  let sections: Map<string, string>;
  if (cached) {
    sections = cached;
  } else {
    sections = parseSections(loadPromptTemplate(relativePath));
    if (!shouldBypassPromptCache) {
      sectionCache.set(relativePath, sections);
    }
  }
  const section = sections.get(sectionName);
  if (!section) {
    throw new Error(`Missing prompt section "${sectionName}" in ${relativePath}`);
  }
  return section;
};

export const renderPromptTemplate = (
  template: string,
  variables: Record<string, string>,
): string =>
  template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    if (!(key in variables)) {
      throw new Error(`Missing prompt variable "${key}"`);
    }
    return variables[key] ?? "";
  });

export const renderPromptSection = (
  relativePath: string,
  sectionName: string,
  variables: Record<string, string>,
): string => renderPromptTemplate(getPromptSection(relativePath, sectionName), variables);
