import type {
  ConversationMessage,
  ConversationModelGateway,
  Directive,
  DirectiveCoherenceCheckInput,
  DirectiveCoherenceChecker,
  DirectiveCoherenceConflict,
  DirectiveCoherenceVerdict,
} from "@radioso/conversation-contract";
export type {
  DirectiveCoherenceCheckInput,
  DirectiveCoherenceChecker,
  DirectiveCoherenceConflict,
  DirectiveCoherenceVerdict,
} from "@radioso/conversation-contract";

export interface CreateDirectiveCoherenceCheckerOptions {
  modelGateway: ConversationModelGateway;
  promptTemplate?: string;
}

export type DirectiveCoherenceMode = "enforce";

export interface DirectiveCoherenceGateOptions {
  enabled?: boolean;
  mode?: DirectiveCoherenceMode;
  checker?: DirectiveCoherenceChecker;
  promptTemplate?: string;
}

export interface DirectiveCoherenceGate {
  mode: DirectiveCoherenceMode;
  checker: DirectiveCoherenceChecker;
}

export const DEFAULT_DIRECTIVE_COHERENCE_PROMPT = `You review assistant behavioral directives before they are accepted.

Decide whether the candidate directive can be followed together with every existing
directive for the same agent. Directives and conditions may be written in any
language; judge by meaning, not by matching words.

Return only one JSON object with this exact shape:

{"verdict": "coherent" | "conflict", "conflicts": [{"directiveId": "<existing directive id when present>", "directiveName": "<existing directive name>", "reason": "<short reason>"}], "rationale": "<short rationale>"}

Rules:

- Use "coherent" only when the candidate and existing directives can all be obeyed.
- Use "conflict" when the candidate contradicts, forbids, requires the opposite of,
  or makes it impossible to obey an existing directive under overlapping conditions.
- Report conflicts only against existing directives, never against the candidate.
- Use only existing directive ids and names from the input. Do not invent directives.
- Return an empty conflicts array when the verdict is "coherent".`;

export class DirectiveCoherenceError extends Error {
  readonly code = "conversation_kit_directive_coherence_conflict";
  readonly verdict: DirectiveCoherenceVerdict;

  constructor(verdict: DirectiveCoherenceVerdict) {
    super("conversation_kit_directive_coherence_conflict");
    this.name = "DirectiveCoherenceError";
    this.verdict = verdict;
  }
}

const directiveConditionText = (directive: Directive): string =>
  directive.condition.kind === "contextual" ? directive.condition.description : "always";

const directivePayload = (directive: Directive): Record<string, unknown> => ({
  id: directive.id,
  name: directive.name,
  condition: {
    kind: directive.condition.kind,
    description: directive.condition.kind === "contextual" ? directive.condition.description : undefined,
  },
  action: directive.action,
  priority: directive.priority,
  requiredCapabilities: directive.requiredCapabilities,
  dependsOn: directive.dependsOn,
  excludes: directive.excludes,
  description: directive.description,
  metadata: directive.metadata,
});

const buildCoherenceMessages = (input: DirectiveCoherenceCheckInput): ConversationMessage[] => [{
  role: "user",
  content: JSON.stringify({
    agent: {
      id: input.agent.id,
      name: input.agent.name,
      instructions: input.agent.instructions,
      defaultLocale: input.agent.defaultLocale,
    },
    candidate: directivePayload(input.candidate),
    existingDirectives: input.existingDirectives.map(directivePayload),
  }, null, 2),
}];

const extractJsonObject = (raw: string): string | null => {
  const start = raw.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const fallbackInvalidVerdict = (): DirectiveCoherenceVerdict => ({
  coherent: true,
  conflicts: [],
  rationale: "Coherence check unavailable.",
});

const parseConflict = (
  value: unknown,
  existingDirectives: Directive[],
): DirectiveCoherenceConflict | null => {
  if (!isRecord(value)) {
    return null;
  }
  const directiveId = typeof value.directiveId === "string" ? value.directiveId : undefined;
  const directiveName = typeof value.directiveName === "string" ? value.directiveName : undefined;
  const existing = existingDirectives.find((directive) =>
    (directiveId && directive.id === directiveId) || (directiveName && directive.name === directiveName),
  );
  if (!existing) {
    return null;
  }
  const reason = typeof value.reason === "string" && value.reason.trim()
    ? value.reason.trim()
    : `The model reported a conflict with ${existing.name}.`;
  return {
    directiveId: existing.id,
    directiveName: existing.name,
    reason,
  };
};

const parseModelVerdict = (
  raw: string,
  existingDirectives: Directive[],
): DirectiveCoherenceVerdict | null => {
  const json = extractJsonObject(raw);
  if (!json) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const verdict = parsed.verdict === "coherent" || parsed.verdict === "conflict" ? parsed.verdict : null;
    if (!verdict) {
      return null;
    }
    const rationale = typeof parsed.rationale === "string" && parsed.rationale.trim()
      ? parsed.rationale.trim()
      : verdict === "coherent"
        ? "The candidate is coherent with the existing directives."
        : "The candidate conflicts with existing directives.";
    if (verdict === "coherent") {
      return { coherent: true, conflicts: [], rationale };
    }
    if (!Array.isArray(parsed.conflicts)) {
      return null;
    }
    const conflicts = parsed.conflicts.flatMap((entry) => {
      const conflict = parseConflict(entry, existingDirectives);
      return conflict ? [conflict] : [];
    });
    if (conflicts.length === 0) {
      return null;
    }
    return { coherent: false, conflicts, rationale };
  } catch {
    return null;
  }
};

export class ModelDirectiveCoherenceChecker implements DirectiveCoherenceChecker {
  private readonly promptTemplate: string;

  constructor(
    private readonly modelGateway: ConversationModelGateway,
    options: { promptTemplate?: string } = {},
  ) {
    this.promptTemplate = options.promptTemplate ?? DEFAULT_DIRECTIVE_COHERENCE_PROMPT;
  }

  async check(input: DirectiveCoherenceCheckInput): Promise<DirectiveCoherenceVerdict> {
    if (input.existingDirectives.length === 0) {
      return {
        coherent: true,
        conflicts: [],
        rationale: "No existing directives are present for this agent.",
      };
    }
    const { text } = await this.modelGateway.complete({
      systemPrompt: this.promptTemplate,
      messages: buildCoherenceMessages(input),
      metadata: {
        capability: "directive_coherence",
        candidateDirectiveName: input.candidate.name,
        candidateDirectiveCondition: directiveConditionText(input.candidate),
      },
    });
    return parseModelVerdict(text, input.existingDirectives) ?? fallbackInvalidVerdict();
  }
}

export const createDirectiveCoherenceChecker = (
  options: CreateDirectiveCoherenceCheckerOptions,
): DirectiveCoherenceChecker => new ModelDirectiveCoherenceChecker(options.modelGateway, {
  promptTemplate: options.promptTemplate,
});

export const createDirectiveCoherenceGate = (
  options: DirectiveCoherenceGateOptions | undefined,
  modelGateway: ConversationModelGateway,
): DirectiveCoherenceGate | undefined => {
  if (!options || options.enabled === false) {
    return undefined;
  }
  return {
    mode: options.mode ?? "enforce",
    checker: options.checker ?? createDirectiveCoherenceChecker({
      modelGateway,
      promptTemplate: options.promptTemplate,
    }),
  };
};
