import { routineReentryModes, type RoutineDefinitionDraftInput, type RoutineReentryMode } from "../domain.js";
import {
  encodeRoutineDocumentText,
  routineDocumentToDraft,
} from "./transform.js";
import type {
  DocumentPosition,
  DocumentTextRange,
  RoutineDocument,
  RoutineDocumentBranch,
  RoutineDocumentDiagnostic,
  RoutineDocumentParseOptions,
  RoutineDocumentParseResult,
  RoutineDocumentPlaceholderSection,
  RoutineDocumentRoutineSection,
  RoutineDocumentSourceMap,
  RoutineDocumentStep,
} from "./model.js";

const identifier = "[A-Za-z_][A-Za-z0-9_.-]*";
const anchorPattern = new RegExp(`\\{#(${identifier})\\}`);
const variablePattern = new RegExp(`^-\\s*(${identifier})(\\?)?:\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*(?:[-—]\\s*(.*))?$`);
const endPattern = new RegExp(`^-\\s*(${identifier})\\s*\\[(complete|handoff)\\]:\\s*(.*)$`);
const transitionPattern = new RegExp(`^(?:if\\s+(.+?)\\s+)?(?:->|→)\\s*#(${identifier})(.*)$`, "u");
const tokenLessBeatPattern = /^if\s+(.+):\s*$/u;
const needsPattern = /^needs\s+(.+)$/u;

const emptySourceMap = (): RoutineDocumentSourceMap => ({ stableIds: {}, slots: {}, transitions: {} });

interface LineInfo {
  text: string;
  line: number;
  offset: number;
}

const linesFor = (text: string): LineInfo[] => {
  const lines: LineInfo[] = [];
  let offset = 0;
  for (const raw of text.split(/(?<=\n)/u)) {
    const lineText = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    lines.push({ text: lineText, line: lines.length + 1, offset });
    offset += raw.length;
  }
  if (text.length === 0) {
    lines.push({ text: "", line: 1, offset: 0 });
  }
  return lines;
};

const position = (line: LineInfo, column: number): DocumentPosition => ({
  offset: line.offset + column,
  line: line.line,
  column: column + 1,
});

const lineRange = (line: LineInfo): DocumentTextRange => ({
  start: position(line, 0),
  end: position(line, line.text.length),
});

const rangeFromLines = (start: LineInfo, end: LineInfo): DocumentTextRange => ({
  start: position(start, 0),
  end: position(end, end.text.length),
});

const sortedRoutineSection = (document: RoutineDocument): RoutineDocumentRoutineSection => {
  const section = document.sections.find((candidate): candidate is RoutineDocumentRoutineSection => candidate.kind === "routine");
  return section ?? { kind: "routine", variables: [], steps: [], ends: [] };
};

const formatFrontmatter = (document: RoutineDocument): string[] => {
  const lines = [
    "---",
    `name: ${document.name}`,
    `trigger: ${document.activation.triggerDescription}`,
    `priority: ${document.activation.priority}`,
  ];
  if (document.activation.gateRef) {
    lines.push(`gate: ${document.activation.gateRef}`);
  }
  // Only emit a non-default reentry policy so existing fixtures stay byte-identical.
  if (document.activation.reentryMode && document.activation.reentryMode !== "once_per_conversation") {
    lines.push(`reentry: ${document.activation.reentryMode}`);
  }
  lines.push("---");
  return lines;
};

const formatGuard = (branch: RoutineDocumentBranch): string => {
  switch (branch.guard.kind) {
    case "llm":
      return `if ${branch.guard.text} -> #${branch.target.stableId}`;
    case "slot_filled":
      return `-> #${branch.target.stableId} [needs ${branch.guard.slots.map((slot) => `@${slot}`).join(", ")}]`;
    case "outcome":
      return `-> #${branch.target.stableId} [${branch.guard.status}]`;
    case "counter":
      return `-> #${branch.target.stableId} ↺${branch.guard.limit}`;
    default:
      return `-> #${branch.target.stableId}`;
  }
};

export const serializeRoutineDocument = (document: RoutineDocument): string => {
  const section = sortedRoutineSection(document);
  const lines = [
    ...formatFrontmatter(document),
    "",
    "## Variables",
    ...section.variables.map((slot) => `- ${slot.key}${slot.required ? "" : "?"}: ${slot.type}${slot.description ? ` - ${slot.description}` : ""}`),
    "",
    "## Steps",
    "",
    ...section.steps.flatMap((step, index) => [
      `${index + 1}. ${step.instruction} {#${step.stableStepId}}`,
      ...step.branches.map((branch) => `   ${formatGuard(branch)}`),
      "",
    ]),
    "## Ends",
    ...section.ends.map((end) => `- ${end.stableStepId} [${end.kind}]: ${end.instruction ?? ""}`),
  ];
  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n")}\n`;
};

const parseReentryMode = (value: string | undefined): RoutineReentryMode =>
  value && (routineReentryModes as readonly string[]).includes(value)
    ? (value as RoutineReentryMode)
    : "once_per_conversation";

const parseFrontmatter = (lineInfos: LineInfo[], diagnostics: RoutineDocumentDiagnostic[]): {
  name: string;
  triggerDescription: string;
  priority: number;
  gateRef: string | null;
  reentryMode: RoutineReentryMode;
  startIndex: number;
  range?: DocumentTextRange;
} => {
  if (lineInfos[0]?.text.trim() !== "---") {
    diagnostics.push({ code: "missing_frontmatter", location: "routine", message: "fixture is missing frontmatter." });
    return { name: "", triggerDescription: "", priority: 0, gateRef: null, reentryMode: "once_per_conversation", startIndex: 0 };
  }
  const values = new Map<string, string>();
  let index = 1;
  while (index < lineInfos.length && lineInfos[index]!.text.trim() !== "---") {
    const line = lineInfos[index]!;
    const separator = line.text.indexOf(":");
    if (separator === -1) {
      diagnostics.push({ code: "invalid_frontmatter", location: "routine", message: "frontmatter line must use key: value syntax.", range: lineRange(line) });
    } else {
      values.set(line.text.slice(0, separator).trim(), line.text.slice(separator + 1).trim());
    }
    index += 1;
  }
  const priority = Number.parseInt(values.get("priority") ?? "0", 10);
  return {
    name: values.get("name") ?? "",
    triggerDescription: values.get("trigger") ?? "",
    priority: Number.isInteger(priority) ? priority : 0,
    gateRef: values.get("gate") ?? null,
    reentryMode: parseReentryMode(values.get("reentry")),
    startIndex: Math.min(index + 1, lineInfos.length),
    range: rangeFromLines(lineInfos[0]!, lineInfos[Math.min(index, lineInfos.length - 1)]!),
  };
};

const sectionName = (line: string): string | null => {
  const match = /^##\s+(.+?)\s*$/u.exec(line.trim());
  return match?.[1]?.toLowerCase() ?? null;
};

const trailingMentionPunctuationPattern = /[.,;:!?]+$/u;

const mentionTokens = (text: string): Set<string> =>
  new Set([...text.matchAll(/@([A-Za-z_][A-Za-z0-9_.-]*)/gu)]
    .map((match) => match[1]!.replace(trailingMentionPunctuationPattern, ""))
    .filter(Boolean));

const isStepContinuation = (line: string): boolean => {
  const trimmed = line.trim();
  return Boolean(trimmed) &&
    !sectionName(trimmed) &&
    !/^\d+\.\s+/u.test(trimmed) &&
    !transitionPattern.test(trimmed) &&
    !tokenLessBeatPattern.test(trimmed);
};

const resolveStepKind = (
  instruction: string,
  actionNames: Set<string>,
  actionKinds: Readonly<Record<string, "tool" | "action">>,
): Pick<RoutineDocumentStep, "kind" | "toolRef" | "actionType"> => {
  const mentions = mentionTokens(instruction);
  for (const actionName of actionNames) {
    if (mentions.has(actionName)) {
      const actionKind = actionKinds[actionName] ?? "tool";
      return actionKind === "action"
        ? { kind: "action", toolRef: null, actionType: actionName }
        : { kind: "tool", toolRef: actionName, actionType: null };
    }
  }
  return { kind: "chat", toolRef: null, actionType: null };
};

const parseGuardTail = (
  tail: string,
  condition: string | undefined,
  diagnostics: RoutineDocumentDiagnostic[],
  range: DocumentTextRange,
): RoutineDocumentBranch["guard"] => {
  const trimmed = tail.trim();
  const counterMatch = /↺(\d+)\s*$/u.exec(trimmed);
  const markerMatch = /\[([^\]]+)\]/u.exec(trimmed);
  const markerCount = (counterMatch ? 1 : 0) + (markerMatch ? 1 : 0) + (condition ? 1 : 0);
  if (markerCount > 1) {
    diagnostics.push({
      code: "invalid_guard_marker",
      location: "transition",
      message: "a branch can declare only one guard marker.",
      range,
    });
  }
  if (condition) {
    return { kind: "llm", text: condition.trim() };
  }
  if (counterMatch?.[1]) {
    return { kind: "counter", limit: Number.parseInt(counterMatch[1], 10) };
  }
  const marker = markerMatch?.[1]?.trim();
  if (marker) {
    if (marker === "always" || marker === "fallback" || marker === "default") {
      return { kind: "default" };
    }
    const needs = needsPattern.exec(marker);
    if (needs?.[1]) {
      return {
        kind: "slot_filled",
        slots: [...needs[1].matchAll(/@([A-Za-z_][A-Za-z0-9_.-]*)/gu)].map((match) => match[1]!).filter(Boolean),
      };
    }
    return { kind: "outcome", status: marker };
  }
  return { kind: "default" };
};

export const parseRoutineDocumentFixture = (
  text: string,
  options: RoutineDocumentParseOptions = {},
): RoutineDocumentParseResult => {
  const diagnostics: RoutineDocumentDiagnostic[] = [];
  const sourceMap = emptySourceMap();
  const lineInfos = linesFor(text);
  const frontmatter = parseFrontmatter(lineInfos, diagnostics);
  if (frontmatter.range) {
    sourceMap.routine = frontmatter.range;
  }
  const variables: RoutineDocumentRoutineSection["variables"] = [];
  const steps: RoutineDocumentRoutineSection["steps"] = [];
  const ends: RoutineDocumentRoutineSection["ends"] = [];
  const placeholders: RoutineDocumentPlaceholderSection[] = [];
  const actionNames = new Set(options.actionNames ?? []);
  const actionKinds = options.actionKinds ?? {};
  let currentSection: string | null = null;
  let currentStep: RoutineDocumentStep | null = null;
  let branchOrdinal = 0;

  for (let index = frontmatter.startIndex; index < lineInfos.length; index += 1) {
    const line = lineInfos[index]!;
    const trimmed = line.text.trim();
    if (!trimmed) {
      continue;
    }
    const nextSection = sectionName(trimmed);
    if (nextSection) {
      currentSection = nextSection;
      currentStep = null;
      if (!["variables", "steps", "ends", "guidelines", "glossary"].includes(currentSection)) {
        diagnostics.push({ code: "invalid_section", location: `section:${currentSection}`, message: `unsupported fixture section "${currentSection}".`, range: lineRange(line) });
      }
      continue;
    }

    if (currentSection === "variables") {
      const match = variablePattern.exec(trimmed);
      if (!match?.[1] || !match[3]) {
        diagnostics.push({ code: "invalid_section", location: "section:variables", message: "variable declarations must be '- key: type - description'.", range: lineRange(line) });
        continue;
      }
      variables.push({
        stableSlotId: match[1],
        key: match[1],
        type: match[3] as RoutineDefinitionDraftInput["slots"][number]["type"],
        required: !match[2],
        description: match[4]?.trim() || null,
        ordinal: variables.length,
        range: lineRange(line),
      });
      sourceMap.slots[match[1]] = lineRange(line);
      continue;
    }

    if (currentSection === "steps") {
      const stepMatch = /^\d+\.\s+(.+)$/u.exec(trimmed);
      if (stepMatch?.[1]) {
        const instructionLines = [stepMatch[1].trim()];
        let lastLine = line;
        while (index + 1 < lineInfos.length && isStepContinuation(lineInfos[index + 1]!.text)) {
          index += 1;
          lastLine = lineInfos[index]!;
          instructionLines.push(lastLine.text.trim());
        }
        const rawInstruction = instructionLines.join(" ");
        const anchor = anchorPattern.exec(rawInstruction);
        if (!anchor?.[1]) {
          diagnostics.push({ code: "missing_anchor", location: "step", message: "step lines must declare a stable anchor like {#id}.", range: rangeFromLines(line, lastLine) });
          continue;
        }
        const instruction = rawInstruction.replace(anchorPattern, "").trim();
        const actionShape = resolveStepKind(instruction, actionNames, actionKinds);
        currentStep = {
          stableStepId: anchor[1],
          label: null,
          instruction,
          ...actionShape,
          metadata: {},
          ordinal: steps.length,
          branches: [],
          range: rangeFromLines(line, lastLine),
        };
        if (sourceMap.stableIds[anchor[1]]) {
          diagnostics.push({ code: "duplicate_anchor", location: `step:${anchor[1]}`, message: `duplicate anchor "${anchor[1]}".`, range: rangeFromLines(line, lastLine) });
        }
        sourceMap.stableIds[anchor[1]] = rangeFromLines(line, lastLine);
        steps.push(currentStep);
        continue;
      }

      const transitionMatch = transitionPattern.exec(trimmed);
      if (transitionMatch?.[2] && currentStep) {
        const branch: RoutineDocumentBranch = {
          fromStepId: currentStep.stableStepId,
          target: { kind: "step", stableId: transitionMatch[2] },
          guard: parseGuardTail(transitionMatch[3] ?? "", transitionMatch[1], diagnostics, lineRange(line)),
          ordinal: branchOrdinal,
          range: lineRange(line),
        };
        branchOrdinal += 1;
        currentStep.branches.push(branch);
        sourceMap.transitions[`${branch.fromStepId}->${branch.target.stableId}`] = lineRange(line);
        continue;
      }

      if (tokenLessBeatPattern.test(trimmed) && currentStep) {
        diagnostics.push({
          code: "token_less_branch_beat",
          location: `step:${currentStep.stableStepId}`,
          message: "this branch needs a destination: declare a step, choose an end, or fold it into the instruction.",
          range: lineRange(line),
        });
      }
      continue;
    }

    if (currentSection === "ends") {
      const match = endPattern.exec(trimmed);
      if (!match?.[1] || !match[2]) {
        diagnostics.push({ code: "invalid_section", location: "section:ends", message: "end declarations must be '- id [complete|handoff]: message'.", range: lineRange(line) });
        continue;
      }
      ends.push({
        stableStepId: match[1],
        kind: match[2] as RoutineDefinitionDraftInput["terminals"][number]["kind"],
        instruction: match[3] || null,
        ordinal: ends.length,
        range: lineRange(line),
      });
      sourceMap.stableIds[match[1]] = lineRange(line);
      continue;
    }

    if (currentSection === "guidelines" || currentSection === "glossary") {
      let placeholder = placeholders.find((candidate) => candidate.kind === currentSection);
      if (!placeholder) {
        placeholder = { kind: currentSection, lines: [], range: lineRange(line) };
        placeholders.push(placeholder);
      }
      placeholder.lines.push(trimmed);
    }
  }

  const variableNames = new Set(variables.map((variable) => variable.key));
  for (const name of actionNames) {
    if (variableNames.has(name)) {
      diagnostics.push({
        code: "ambiguous_reference_name",
        location: `reference:${name}`,
        message: `reference "${name}" is declared as both a variable and an action.`,
      });
    }
  }

  if (steps.length === 0 || ends.length === 0) {
    diagnostics.push({ code: "missing_section", location: "section:routine", message: "fixture must declare steps and ends." });
  }

  const terminalIds = new Set(ends.map((end) => end.stableStepId));
  for (const step of steps) {
    for (const branch of step.branches) {
      if (terminalIds.has(branch.target.stableId)) {
        branch.target.kind = "end";
      }
    }
  }

  const document: RoutineDocument = {
    name: frontmatter.name,
    activation: {
      triggerDescription: frontmatter.triggerDescription,
      gateRef: frontmatter.gateRef,
      priority: frontmatter.priority,
      reentryMode: frontmatter.reentryMode,
    },
    sections: [{ kind: "routine", variables, steps, ends }, ...placeholders],
  };

  const draftSourceMap = routineDocumentToDraft(document).sourceMap;
  return {
    document,
    diagnostics,
    sourceMap: {
      ...draftSourceMap,
      stableIds: { ...draftSourceMap.stableIds, ...sourceMap.stableIds },
      slots: { ...draftSourceMap.slots, ...sourceMap.slots },
      transitions: { ...draftSourceMap.transitions, ...sourceMap.transitions },
      routine: sourceMap.routine,
    },
  };
};

export { encodeRoutineDocumentText };
