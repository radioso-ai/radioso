import type { Metadata } from "next";

import { OrganizationsPage } from "../components/organizations-page";

export const metadata: Metadata = {
  title: "Organizations | Operator Console",
};

export default function OperatorOrganizationsPage() {
  return <OrganizationsPage />;
}
