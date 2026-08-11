import type { AccountPermission } from "../account/services/accountAccessService.js";
import type { CopilotToolDescriptor } from "./contracts.js";

export const filterCopilotToolCatalog = (
  descriptors: ReadonlyArray<CopilotToolDescriptor>,
  permissions: ReadonlySet<AccountPermission>,
): ReadonlyArray<CopilotToolDescriptor> => descriptors.filter((descriptor) => permissions.has(descriptor.requiredPermission));
