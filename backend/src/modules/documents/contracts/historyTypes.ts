export interface DocumentSearchHistoryEntry {
  searchId: string;
  query: string;
  createdAt: string;
  resultCount: number;
  traceAvailable: boolean;
  previewTopTitles: string[];
}

export interface DocumentSearchHistoryPage {
  searches: DocumentSearchHistoryEntry[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}
