import type { Metadata } from "next";

import { LoginForm } from "../components/login-form";

export const metadata: Metadata = {
  title: "Staff sign in | Operator Console",
};

export default function OperatorLoginPage() {
  return <LoginForm />;
}
