import type { SkillOutcome } from "@radioso/conversation-contract";

import type {
  ConversationToolDefinition,
  ToolCallContext,
  ToolCallInput,
  ToolCallResult,
  ToolService,
} from "./types.js";

export type LocalToolHandler<Input = unknown, Output = unknown> = (
  input: Input,
  context: ToolCallContext,
) => Promise<Output | ToolCallResult | SkillOutcome> | Output | ToolCallResult | SkillOutcome;

export interface LocalFunctionTool<Input = unknown, Output = unknown> extends ConversationToolDefinition {
  execute: LocalToolHandler<Input, Output>;
}

export class LocalFunctionToolService implements ToolService {
  private readonly tools = new Map<string, LocalFunctionTool>();

  constructor(tools: LocalFunctionTool[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: LocalFunctionTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  async listTools(): Promise<ConversationToolDefinition[]> {
    return [...this.tools.values()].map(({ execute: _execute, ...definition }) => definition);
  }

  // The port declares `ToolCallResult | SkillOutcome | unknown`; `unknown` already
  // subsumes the other members, so this is the same type without the redundant listing.
  async callTool(input: ToolCallInput): Promise<unknown> {
    const tool = this.tools.get(input.toolName);
    if (!tool) {
      throw new Error(`Tool "${input.toolName}" is not registered`);
    }
    return tool.execute(input.input, input.context ?? {});
  }
}

export const createLocalFunctionToolService = (tools: LocalFunctionTool[] = []): LocalFunctionToolService =>
  new LocalFunctionToolService(tools);
