export interface DocumentJobDispatchRequest {
  jobId: string;
  documentId: string;
  workspaceId: string;
  revision: number;
  scheduleAt?: Date;
}

export interface DocumentJobDispatcherPort {
  dispatch(input: DocumentJobDispatchRequest): Promise<void>;
  dispatchMany(inputs: DocumentJobDispatchRequest[]): Promise<void>;
}

export class NoopDocumentJobDispatcher implements DocumentJobDispatcherPort {
  async dispatch(_input: DocumentJobDispatchRequest): Promise<void> {}

  async dispatchMany(_inputs: DocumentJobDispatchRequest[]): Promise<void> {}
}
