export interface ReviewedChangeEffect {
  readonly exposure: "draft" | "live";
  readonly reversibility: "reversible" | "irreversible";
  readonly metered: boolean;
}
