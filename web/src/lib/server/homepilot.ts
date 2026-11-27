import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { createDemoSource } from "@/lib/homepilot/demo";
import { createHttpSource, type HomePilotSource } from "@/lib/homepilot/source";
import { env } from "./env";
import { SESSION_COOKIE, sessionSecret, verifySession } from "./session";

/**
 * Data access layer. Every page and action gets HomePilot data through here, and this is where the
 * session is checked (Proxy only does an early redirect). Keep it the only importer of the token.
 */

let demo: HomePilotSource | undefined;

export async function isSignedIn(): Promise<boolean> {
  const e = env();
  if (e.HOMEPILOT_MODE === "demo") return true;
  const secret = await sessionSecret({ explicit: e.DASHBOARD_SESSION_SECRET, apiToken: e.HOMEPILOT_API_TOKEN });
  return verifySession(secret, (await cookies()).get(SESSION_COOKIE)?.value, Date.now());
}

export async function getHomePilot(): Promise<HomePilotSource> {
  // HomePilot data is live and per request, so it is never part of a prerendered shell.
  await connection();
  const e = env();
  if (e.HOMEPILOT_MODE === "demo") {
    demo ??= createDemoSource();
    return demo;
  }
  if (!(await isSignedIn())) redirect("/login");
  return createHttpSource({ baseUrl: e.HOMEPILOT_API_URL, token: e.HOMEPILOT_API_TOKEN! });
}

export function dashboardMode(): "live" | "demo" {
  return env().HOMEPILOT_MODE;
}
