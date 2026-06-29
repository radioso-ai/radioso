"use client";

import { Button } from "@radioso/ui/button";
import { Input } from "@radioso/ui/input";
import { KeyRound, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";

import { staffAuthApi } from "../lib/staff-auth-api";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await staffAuthApi.login({ email, password });
      window.location.href = "/operator/organizations";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-100">
      <form onSubmit={submit} className="w-full max-w-sm rounded-md border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-normal">Staff sign in</h1>
            <p className="text-sm text-zinc-400">Radioso operator access</p>
          </div>
        </div>
        <div className="space-y-4">
          <label className="block text-sm font-medium text-zinc-200">
            Email
            <Input
              className="mt-2 border-zinc-700 bg-zinc-950 text-zinc-100"
              autoComplete="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label className="block text-sm font-medium text-zinc-200">
            Password
            <Input
              className="mt-2 border-zinc-700 bg-zinc-950 text-zinc-100"
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
        </div>
        {error ? <div className="mt-4 rounded-md border border-red-500/30 bg-red-950/40 px-3 py-2 text-sm text-red-100">{error}</div> : null}
        <Button className="mt-6 w-full" type="submit" disabled={submitting}>
          <KeyRound className="size-4" />
          {submitting ? "Signing in" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
