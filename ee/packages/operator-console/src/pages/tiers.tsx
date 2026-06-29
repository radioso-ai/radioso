import type { Metadata } from "next";

import { TiersPage } from "../components/tiers-page";

export const metadata: Metadata = {
  title: "Usage tiers | Operator Console",
};

export default function OperatorTiersPage() {
  return <TiersPage />;
}
