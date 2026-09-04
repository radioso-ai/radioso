import {
  createOperatorMcpProof,
  verifyOperatorMcpProof,
  type OperatorMcpProof,
} from "@radioso/operator-mcp-contract";

export type OperatorProofClaims = Omit<OperatorMcpProof, "signature">;

export const createOperatorProof = (
  claims: OperatorProofClaims,
  secret: string,
): OperatorMcpProof => createOperatorMcpProof({ ...claims, secret });

export const verifyOperatorProof = (
  proof: OperatorMcpProof,
  secret: string,
  now = Date.now(),
): boolean => verifyOperatorMcpProof({ proof, secret, now });
