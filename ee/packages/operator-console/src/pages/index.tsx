import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Operator Console",
};

export default function OperatorConsoleIndexPage() {
  redirect("/operator/organizations");
}
