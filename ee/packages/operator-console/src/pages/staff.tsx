import type { Metadata } from "next";

import { StaffPage } from "../components/staff-page";

export const metadata: Metadata = {
  title: "Staff | Operator Console",
};

export default function OperatorStaffPage() {
  return <StaffPage />;
}
