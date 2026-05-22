export interface JobConsumerPort {
  start(): Promise<void>;
  stop(): Promise<void>;
}
