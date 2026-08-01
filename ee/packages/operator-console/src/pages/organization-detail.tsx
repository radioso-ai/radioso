import type { Metadata } from "next";

import { OrganizationDetailPage } from "../components/organization-detail-page";

export const metadata: Metadata = {
  title: "Organization usage | Operator Console",
};

export default async function OperatorOrganizationDetailPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const resolvedParams = await params;
  return <OrganizationDetailPage accountId={resolvedParams.accountId} />;
}
