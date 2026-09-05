import type ts from "typescript";

export type UnboundMethodAllowlistEntry = {
  file: string;
  member: string;
  receiver: string;
  reason: string;
};

export type UnboundMethodFinding = {
  file: string;
  line: number;
  column: number;
  member: string;
  receiver: string;
};

export function findUnboundMethodReferences(
  program: ts.Program,
  options: {
    sourceDirectory: string;
    repositoryDirectory: string;
    allowlist: readonly UnboundMethodAllowlistEntry[];
  },
): {
  findings: UnboundMethodFinding[];
  staleAllowlistEntries: UnboundMethodAllowlistEntry[];
};

export function createRuntimeProgram(backendDirectory: string): ts.Program;
