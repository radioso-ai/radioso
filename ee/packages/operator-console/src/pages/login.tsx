import type { Metadata } from "next";

import { LoginForm } from "../components/login-form";

export const metadata: Metadata = {
  title: "Staff sign in | Operator Console",
};

export default async function OperatorLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return (
    <LoginForm signInError={error === "google_account_refused" || error === "google_sign_in_failed" ? error : null} />
  );
}
