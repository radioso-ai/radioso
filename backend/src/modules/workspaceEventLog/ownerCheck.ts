import type { AccountPermission } from "../account/public.js";
import type { StoredEventSubscriptionCreator } from "../../shared/domain/workspaceEventSubscriptions.js";

/**
 * Whether the credential or teammate that created a subscription may still read what it subscribes
 * to: the credential is neither revoked nor expired, its service account is enabled or its owner is
 * still a member, and its role still grants every permission in `permissions`. A creator whose row
 * is gone is not permitted. Application composition adapts it from machine access and account
 * access, so delivery never learns how credentials are stored or roles resolved.
 */
export interface EventSubscriptionOwnerCheck {
  permits(input: {
    workspaceId: string;
    createdBy: StoredEventSubscriptionCreator;
    permissions: readonly AccountPermission[];
  }): Promise<boolean>;
}
