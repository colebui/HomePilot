"use server";

import { refresh } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { HomePilotError } from "@/lib/homepilot/source";
import { env } from "@/lib/server/env";
import { getHomePilot } from "@/lib/server/homepilot";
import { SESSION_COOKIE, SESSION_TTL_MS, safeEqual, sessionSecret, signSession } from "@/lib/server/session";

/**
 * Server Actions. Each one checks the session itself (getHomePilot redirects to /login without
 * one), because actions can be called by a direct POST, not just from this UI.
 */

export interface CommandState {
  reply: string | null;
  error: string | null;
  understoodBy?: string;
  model?: string;
}

const failure = (err: unknown): string =>
  err instanceof HomePilotError ? err.message : "Something went wrong. Nothing was changed.";

export async function sendCommand(_prev: CommandState, form: FormData): Promise<CommandState> {
  const text = z.string().trim().min(1).max(1000).safeParse(form.get("text"));
  if (!text.success) return { reply: null, error: "Type something for HomePilot first." };
  try {
    const hp = await getHomePilot();
    const out = await hp.say(text.data);
    refresh();
    return { reply: out.reply, error: null, understoodBy: out.understoodBy, model: out.model };
  } catch (err) {
    return { reply: null, error: failure(err) };
  }
}

const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/);

export async function completeTask(id: string): Promise<{ ok: boolean; error?: string }> {
  const parsed = Id.safeParse(id);
  if (!parsed.success) return { ok: false, error: "Unknown task." };
  try {
    await (await getHomePilot()).completeTask(parsed.data);
    refresh();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: failure(err) };
  }
}

export async function deleteExpense(id: string): Promise<{ ok: boolean; error?: string }> {
  const parsed = Id.safeParse(id);
  if (!parsed.success) return { ok: false, error: "Unknown expense." };
  try {
    await (await getHomePilot()).deleteExpense(parsed.data);
    refresh();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: failure(err) };
  }
}

/** Approve or deny goes through the same path as a text, so the service's own rules apply. */
export async function decideApproval(code: string, decision: "approve" | "deny"): Promise<CommandState> {
  const parsed = z.string().regex(/^[A-Z0-9]{4,8}$/).safeParse(code);
  if (!parsed.success) return { reply: null, error: "Unknown approval." };
  try {
    const out = await (await getHomePilot()).say(`${decision} ${parsed.data}`);
    refresh();
    return { reply: out.reply, error: null };
  } catch (err) {
    return { reply: null, error: failure(err) };
  }
}

export async function login(_prev: { error: string | null }, form: FormData): Promise<{ error: string | null }> {
  const e = env();
  if (e.HOMEPILOT_MODE === "demo") redirect("/");
  const given = String(form.get("token") ?? "");
  if (!given || !(await safeEqual(given, e.HOMEPILOT_API_TOKEN!))) {
    // Same message for every failure, and a short pause to slow down guessing.
    await new Promise((r) => setTimeout(r, 600));
    return { error: "That token didn't match." };
  }
  const secret = await sessionSecret({ explicit: e.DASHBOARD_SESSION_SECRET, apiToken: e.HOMEPILOT_API_TOKEN });
  const expires = Date.now() + SESSION_TTL_MS;
  (await cookies()).set(SESSION_COOKIE, await signSession(secret, expires), {
    httpOnly: true,
    sameSite: "strict",
    // Secure whenever the dashboard is reached over HTTPS (for example through Tailscale Serve).
    secure: ((await headers()).get("origin") ?? "").startsWith("https://"),
    path: "/",
    expires: new Date(expires),
  });
  redirect("/");
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
