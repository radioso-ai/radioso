export interface UsageLimitReservation {
  commit(): Promise<void>;
  release(): Promise<void>;
}

export interface IndexedStorageReservationInput {
  accountId?: string | null;
  workspaceId: string;
  contentSizeBytes: number;
  sourceKind?: string;
  externalDocumentId?: string | null;
}

export interface UsageLimitPolicy {
  reserveAnswer(input: {
    accountId?: string | null;
    workspaceId: string;
    surface: string;
  }): Promise<UsageLimitReservation>;
  reserveDocument(input: {
    accountId?: string | null;
    workspaceId: string;
    sourceKind: string;
    externalDocumentId?: string | null;
  }): Promise<UsageLimitReservation>;
  reserveIndexedStorage(input: IndexedStorageReservationInput): Promise<UsageLimitReservation>;
}

const noopReservation: UsageLimitReservation = {
  async commit() {},
  async release() {},
};

export class NoopUsageLimitPolicy implements UsageLimitPolicy {
  async reserveAnswer(): Promise<UsageLimitReservation> {
    return noopReservation;
  }

  async reserveDocument(): Promise<UsageLimitReservation> {
    return noopReservation;
  }

  async reserveIndexedStorage(_input: IndexedStorageReservationInput): Promise<UsageLimitReservation> {
    return noopReservation;
  }
}
