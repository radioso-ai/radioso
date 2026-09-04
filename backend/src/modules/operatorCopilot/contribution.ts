import type { CopilotToolDescriptor } from "./contracts.js";

/**
 * How a module outside the first-party catalog contributes tools to Ray.
 *
 * A contribution is more than a descriptor array because catalog governance validates identities
 * the contributing module owns: `assertCopilotCapabilityProvenance` resolves backing operation ids
 * against the OpenAPI document and application primitive ids against
 * `copilotApplicationPrimitiveRegistry`, neither of which describes a surface outside this
 * repository. A contribution declares its own identities instead of the first-party registries
 * enumerating them, so an Enterprise operator surface is governed by the same rules without OSS
 * having to know it exists.
 */
export interface CopilotToolContribution {
  /** The contributing application module's id, used to attribute a rejected declaration. */
  readonly moduleId: string;
  readonly descriptors: ReadonlyArray<CopilotToolDescriptor>;
  /**
   * Operation ids this contribution's descriptors may cite as backing identities, each with the
   * permissions its own HTTP surface requires. The permissions are load-bearing: a descriptor
   * backed by exactly one operation must not be easier to reach through Ray than through HTTP.
   */
  readonly operationPermissions?: Readonly<Record<string, readonly string[]>>;
  /** Application primitives owned by the contributing module, in the first-party registry's shape. */
  readonly applicationPrimitives?: Readonly<Record<string, { readonly owningModule: string; readonly exportedPort: string }>>;
}

export interface ResolvedCopilotToolContributions {
  readonly descriptors: ReadonlyArray<CopilotToolDescriptor>;
  readonly operationIds: ReadonlySet<string>;
  readonly operationPermissions: Readonly<Record<string, readonly string[]>>;
  readonly applicationPrimitiveIds: ReadonlySet<string>;
}

const assertUnclaimed = (
  moduleId: string,
  kind: string,
  identity: string,
  firstParty: ReadonlySet<string>,
  alreadyContributed: ReadonlySet<string>,
): void => {
  // Redeclaring a first-party identity would let a contribution restate the permissions the parity
  // check holds a first-party descriptor to, which is the one thing that check exists to prevent.
  if (firstParty.has(identity)) {
    throw new Error(`Copilot tool contribution "${moduleId}" redeclares first-party ${kind}: ${identity}`);
  }
  if (alreadyContributed.has(identity)) {
    throw new Error(`Copilot tool contribution "${moduleId}" redeclares contributed ${kind}: ${identity}`);
  }
};

/**
 * Flattens contributions into the descriptors and governance identities the catalog assembles,
 * refusing any declaration that collides with a first-party identity or with another contribution.
 */
/**
 * A contributed descriptor is compiled elsewhere, so the type that makes `verificationCost`
 * mandatory in-repo is only advice to it: a module built against an older contract can hand over a
 * descriptor without one. Caught at assembly rather than at invocation, where the missing field
 * would surface as a failed tool call in the middle of an operator's turn.
 */
const assertDeclaresVerificationCost = (moduleId: string, descriptor: CopilotToolDescriptor): void => {
  if (typeof descriptor.verificationCost !== "function") {
    throw new Error(
      `Copilot tool "${descriptor.name}" contributed by "${moduleId}" declares no verificationCost. `
      + "Every descriptor states what one call spends against a turn's verification budget; return 0 if it commands no model work.",
    );
  }
};

const assertDeclaresMcpDisposition = (moduleId: string, descriptor: CopilotToolDescriptor): void => {
  const disposition = descriptor.mcpDisposition;
  if (!disposition) {
    throw new Error(`Copilot tool "${descriptor.name}" contributed by "${moduleId}" declares no operator MCP disposition.`);
  }
  if (disposition.status === "excluded" && disposition.reason.trim().length === 0) {
    throw new Error(`Copilot tool "${descriptor.name}" contributed by "${moduleId}" has a blank operator MCP exclusion reason.`);
  }
};

export const resolveCopilotToolContributions = (
  contributions: ReadonlyArray<CopilotToolContribution>,
  firstParty: { readonly operationIds: ReadonlySet<string>; readonly applicationPrimitiveIds: ReadonlySet<string> },
): ResolvedCopilotToolContributions => {
  const descriptors: CopilotToolDescriptor[] = [];
  const operationIds = new Set<string>();
  const operationPermissions: Record<string, readonly string[]> = {};
  const applicationPrimitiveIds = new Set<string>();

  for (const contribution of contributions) {
    for (const descriptor of contribution.descriptors) {
      assertDeclaresVerificationCost(contribution.moduleId, descriptor);
      assertDeclaresMcpDisposition(contribution.moduleId, descriptor);
    }
    descriptors.push(...contribution.descriptors);
    for (const [operationId, permissions] of Object.entries(contribution.operationPermissions ?? {})) {
      assertUnclaimed(contribution.moduleId, "operation", operationId, firstParty.operationIds, operationIds);
      operationIds.add(operationId);
      operationPermissions[operationId] = permissions;
    }
    for (const primitiveId of Object.keys(contribution.applicationPrimitives ?? {})) {
      assertUnclaimed(contribution.moduleId, "application primitive", primitiveId, firstParty.applicationPrimitiveIds, applicationPrimitiveIds);
      applicationPrimitiveIds.add(primitiveId);
    }
  }

  return { descriptors, operationIds, operationPermissions, applicationPrimitiveIds };
};
