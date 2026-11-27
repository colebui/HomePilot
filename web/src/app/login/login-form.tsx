"use client";

import { useActionState } from "react";
import { login } from "@/app/actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(login, { error: null });
  return (
    <form action={action} className="mt-4 space-y-3">
      <label htmlFor="token" className="block text-xs font-medium text-ink-2">
        Dashboard token
      </label>
      <input
        id="token"
        name="token"
        type="password"
        autoComplete="current-password"
        required
        className="w-full rounded-xl border border-line bg-page px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      {state.error && (
        <p role="alert" className="text-sm text-critical">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className="w-full rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-page disabled:opacity-50">
        {pending ? "Checking…" : "Sign in"}
      </button>
    </form>
  );
}
