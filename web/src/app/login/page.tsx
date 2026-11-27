import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <div className="mx-auto mt-16 max-w-sm rounded-2xl border border-line bg-surface p-6">
      <h1 className="text-lg font-semibold">Sign in to HomePilot</h1>
      <p className="mt-1 text-sm text-ink-2">Paste the dashboard token from HomePilot&apos;s .env file (HOMEPILOT_API_TOKEN).</p>
      <LoginForm />
    </div>
  );
}
