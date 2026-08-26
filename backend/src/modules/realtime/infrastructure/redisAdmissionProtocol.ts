export type AdmissionScriptInput = { accountId: string; workspaceId: string; principalId: string };

export const admissionRedisKeys = (prefix: string, accountId: string): string[] => {
  const slot = `{${accountId}}`;
  return [`${prefix}:admission:${slot}:expiry`, `${prefix}:admission:${slot}:leases`, `${prefix}:admission:${slot}:counts`];
};

export const reconnectRedisKeys = (prefix: string, input: AdmissionScriptInput, principalHash: string): string[] => {
  const slot = `{${input.accountId}}`;
  return [
    `${prefix}:reconnect:${slot}:account`,
    `${prefix}:reconnect:${slot}:workspace:${input.workspaceId}`,
    `${prefix}:reconnect:${slot}:principal:${principalHash}`,
  ];
};

export const admissionScriptArgs = (
  input: AdmissionScriptInput,
  aggregateId: string,
  expected: number,
  desired: number,
  limits: { account: number; workspace: number; principal: number; leaseTtlMs: number; cleanupLimit: number },
  principalHash: string,
  leaseId = "",
): string[] => [
  input.workspaceId,
  aggregateId,
  String(expected),
  String(desired),
  leaseId,
  String(limits.account),
  String(limits.workspace),
  String(limits.principal),
  String(limits.leaseTtlMs),
  String(limits.cleanupLimit),
  principalHash,
];
