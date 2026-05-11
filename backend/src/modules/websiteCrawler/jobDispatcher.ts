export interface WebsiteCrawlJobDispatchRequest {
  jobId: string;
  workspaceId: string;
}

export interface WebsiteCrawlJobDispatcherPort {
  dispatch(input: WebsiteCrawlJobDispatchRequest): Promise<void>;
}

export class NoopWebsiteCrawlJobDispatcher implements WebsiteCrawlJobDispatcherPort {
  async dispatch(_input: WebsiteCrawlJobDispatchRequest): Promise<void> {}
}
