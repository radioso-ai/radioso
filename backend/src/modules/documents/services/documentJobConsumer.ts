export interface DocumentJobConsumerPort {
  start(): Promise<void>;
  stop(): Promise<void>;
}
