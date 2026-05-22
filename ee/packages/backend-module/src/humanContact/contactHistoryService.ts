import type { ContactHistoryDetail } from "../radiosoModuleTypes.js";
import {
  HUMAN_CONTACT_SKILL_NAME,
  mapContactHistoryDetail,
  mapContactHistorySummary,
} from "./humanContactTypes.js";
import type { SkillSubmissionRepository } from "../skillSubmissions/skillSubmissionRepository.js";

export class HumanContactHistoryService {
  constructor(private readonly submissions: SkillSubmissionRepository) {}

  async listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number } = { limit: 50, offset: 0 },
  ) {
    const offset = input.offset ?? 0;
    const { rows, total } = await this.submissions.listByWorkspace({
      workspaceId,
      skillName: HUMAN_CONTACT_SKILL_NAME,
      limit: input.limit,
      offset,
      fieldValidation: "passthrough",
    });
    const contacts = rows.map(mapContactHistorySummary);
    return {
      contacts,
      total,
      nextCursor: null,
      hasMore: offset + contacts.length < total,
    };
  }

  async getById(workspaceId: string, requestId: string): Promise<ContactHistoryDetail | null> {
    const row = await this.submissions.findById(workspaceId, requestId, {
      fieldValidation: "passthrough",
    });
    if (!row || row.skill_name !== HUMAN_CONTACT_SKILL_NAME) {
      return null;
    }
    return mapContactHistoryDetail(row);
  }
}
