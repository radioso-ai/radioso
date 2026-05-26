export interface HumanContactSettingsProvider {
  getSettings(input: { workspaceId: string; accountId?: string | null }): Promise<{
    enabled: boolean;
    configured: boolean;
    emailEnabled: boolean;
    defaultEmail: string | null;
    defaultEmails: string[];
    webhookEnabled: boolean;
    webhookUrl: string | null;
    signingSecretConfigured: boolean;
    updatedAt: string | null;
  }>;
  updateSettings(input: {
    workspaceId: string;
    accountId?: string | null;
    enabled: boolean;
    emailEnabled?: boolean;
    defaultEmail?: string | null;
    defaultEmails?: string[] | null;
    webhookEnabled?: boolean;
    webhookUrl?: string | null;
    signingSecret?: string | null;
    rotateSigningSecret?: boolean;
  }): Promise<{
    enabled: boolean;
    configured: boolean;
    emailEnabled: boolean;
    defaultEmail: string | null;
    defaultEmails: string[];
    webhookEnabled: boolean;
    webhookUrl: string | null;
    signingSecretConfigured: boolean;
    updatedAt: string | null;
  }>;
  revealSigningSecret(input: { workspaceId: string }): Promise<{
    signingSecret: string | null;
  }>;
}
