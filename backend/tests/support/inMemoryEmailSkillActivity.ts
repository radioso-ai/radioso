import { randomUUID } from "node:crypto";

import type {
  CreateEmailSkillActivityInput,
  EmailSkillActivityRecord,
  EmailSkillActivityRepositoryPort,
  ListEmailSkillActivityInput,
} from "../../src/db/repositories/emailSkillActivityRepository.js";

export class InMemoryEmailSkillActivityRepository implements EmailSkillActivityRepositoryPort {
  private readonly records: EmailSkillActivityRecord[] = [];

  async record(input: CreateEmailSkillActivityInput): Promise<EmailSkillActivityRecord> {
    const record: EmailSkillActivityRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      routineId: input.routineId ?? null,
      conversationId: input.conversationId ?? null,
      skillDefinitionId: input.skillDefinitionId,
      connectionId: input.connectionId,
      skillName: input.skillName,
      mode: input.mode,
      outcome: input.outcome,
      recipientSummary: input.recipientSummary,
      providerMessageId: input.providerMessageId ?? null,
      errorCode: input.errorCode ?? null,
      createdAt: new Date(),
    };
    this.records.push(record);
    return record;
  }

  async list(input: ListEmailSkillActivityInput): Promise<EmailSkillActivityRecord[]> {
    return this.records
      .filter((record) => record.workspaceId === input.workspaceId)
      .filter((record) => !input.agentId || record.agentId === input.agentId)
      .filter((record) => !input.connectionId || record.connectionId === input.connectionId)
      .filter((record) => !input.skillDefinitionId || record.skillDefinitionId === input.skillDefinitionId)
      .filter((record) => !input.outcome || record.outcome === input.outcome)
      .filter((record) => !input.createdFrom || record.createdAt >= input.createdFrom)
      .filter((record) => !input.createdTo || record.createdAt <= input.createdTo)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
      .slice(0, input.limit ?? 50);
  }
}
