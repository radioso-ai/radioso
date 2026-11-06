import type { ConnectorRegisteredSource } from "@radioso/connector-api";

import type { DocumentSourceRepositoryPort } from "../../../db/repositories/documentSourceRepository.js";

/**
 * Host-side read of connector sources by external-id prefix. Plugins never get
 * this directly: the registry binds it to each plugin's own `<connectorId>:`
 * namespace as `ConnectorContext.sources`.
 */
export interface ConnectorSourceDirectory {
  listByExternalIdPrefix(input: {
    workspaceId: string;
    externalIdPrefix: string;
  }): Promise<ConnectorRegisteredSource[]>;
}

export const createConnectorSourceDirectory = (
  documentSourceRepository: Pick<DocumentSourceRepositoryPort, "listByKindAndExternalIdPrefix">,
): ConnectorSourceDirectory => ({
  async listByExternalIdPrefix(input) {
    const records = await documentSourceRepository.listByKindAndExternalIdPrefix({
      workspaceId: input.workspaceId,
      kind: "connector",
      externalIdPrefix: input.externalIdPrefix,
    });
    return records.flatMap((record): ConnectorRegisteredSource[] =>
      record.externalId === null
        ? []
        : [
            {
              id: record.id,
              source: {
                externalId: record.externalId,
                name: record.name,
                config: record.config,
                metadata: record.metadata,
              },
            },
          ],
    );
  },
});
