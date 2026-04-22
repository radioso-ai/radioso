import type { IncidentEvent } from "./incidentTypes.js";

export interface IncidentSink {
  record(event: IncidentEvent): Promise<void>;
}

export class NoopIncidentSink implements IncidentSink {
  async record(_event: IncidentEvent): Promise<void> {}
}
