export interface AgentSkillSettingsEntry<TSettings = unknown> {
  readonly skillName: string;
  normalize(input: unknown): TSettings;
}

export class AgentSkillSettingsRegistry {
  private readonly entries = new Map<string, AgentSkillSettingsEntry>();

  register<TSettings>(entry: AgentSkillSettingsEntry<TSettings>): void {
    if (this.entries.has(entry.skillName)) {
      throw new Error(`Agent skill settings "${entry.skillName}" are already registered.`);
    }
    this.entries.set(entry.skillName, entry as AgentSkillSettingsEntry);
  }

  get(skillName: string): AgentSkillSettingsEntry | undefined {
    return this.entries.get(skillName);
  }
}
