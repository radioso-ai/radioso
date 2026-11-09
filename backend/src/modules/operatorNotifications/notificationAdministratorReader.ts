/**
 * The people who can fix a workspace's notification recipients and can be mailed about them: the
 * account's active, enabled, verified owners and admins, and the members a grant makes admins of
 * the workspace, leaving out an address that bounced or stopped notifications from it. The alert
 * about a skipped address and the notice sent in its place both reach exactly this audience.
 */
export interface NotificationAdministratorReader {
  listAdministratorEmails(workspaceId: string): Promise<string[]>;
}
