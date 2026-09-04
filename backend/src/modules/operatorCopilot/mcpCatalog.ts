import type { OperatorMcpScope, OperatorToolDescriptor } from "@radioso/operator-mcp-contract";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { CopilotToolDescriptor, CopilotToolInvocationContext } from "./contracts.js";
import { hasCurrentCopilotToolPermissions } from "./catalog.js";

export class OperatorMcpCatalogError extends Error {
  constructor(readonly code: "unknown_tool" | "forbidden" | "invalid_arguments" | "invalid_result") {
    super(code);
  }
}

const eligible = (descriptor: CopilotToolDescriptor) => {
  const disposition = descriptor.mcpDisposition;
  return disposition?.status === "eligible" ? disposition : null;
};

const jsonSchema = (schema: CopilotToolDescriptor["inputSchema"]): Record<string, unknown> =>
  zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;

export class OperatorMcpCatalogService {
  private readonly descriptors: ReadonlyMap<string, CopilotToolDescriptor>;

  constructor(descriptors: readonly CopilotToolDescriptor[]) {
    this.descriptors = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  }

  async list(input: {
    context: CopilotToolInvocationContext;
    scopes: ReadonlySet<OperatorMcpScope>;
  }): Promise<OperatorToolDescriptor[]> {
    const result: OperatorToolDescriptor[] = [];
    for (const descriptor of this.descriptors.values()) {
      const disposition = eligible(descriptor);
      if (!disposition || !input.scopes.has(disposition.scope)) continue;
      if (!(await hasCurrentCopilotToolPermissions(descriptor, input.context))) continue;
      result.push({
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: jsonSchema(descriptor.inputSchema),
        outputSchema: jsonSchema(descriptor.outputSchema),
        shape: descriptor.shape,
        requiredScope: disposition.scope,
      });
    }
    return result;
  }

  descriptor(name: string): CopilotToolDescriptor | null {
    return this.descriptors.get(name) ?? null;
  }

  async invoke(input: {
    name: string;
    arguments: unknown;
    context: CopilotToolInvocationContext;
    scopes: ReadonlySet<OperatorMcpScope>;
    signal: AbortSignal;
  }): Promise<unknown> {
    const descriptor = this.descriptors.get(input.name);
    if (!descriptor) throw new OperatorMcpCatalogError("unknown_tool");
    const disposition = eligible(descriptor);
    if (!disposition || !input.scopes.has(disposition.scope)) throw new OperatorMcpCatalogError("forbidden");
    if (!(await hasCurrentCopilotToolPermissions(descriptor, input.context))) throw new OperatorMcpCatalogError("forbidden");
    const parsedInput = descriptor.inputSchema.safeParse(input.arguments);
    if (!parsedInput.success) throw new OperatorMcpCatalogError("invalid_arguments");
    const tool = descriptor.createTool(input.context);
    const output = await tool.invoke(parsedInput.data, { signal: input.signal, callId: input.context.operatorMcpInvocationId ?? "operator-mcp", stepIndex: 0 });
    if (!(await hasCurrentCopilotToolPermissions(descriptor, input.context))) throw new OperatorMcpCatalogError("forbidden");
    const parsedOutput = descriptor.outputSchema.safeParse(output);
    if (!parsedOutput.success) throw new OperatorMcpCatalogError("invalid_result");
    return parsedOutput.data;
  }
}
