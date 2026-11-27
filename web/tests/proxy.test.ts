import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import { SESSION_COOKIE, sessionSecret, signSession } from "@/lib/server/session";

const TOKEN = "live-token-0123456789abcdef";

afterEach(() => vi.unstubAllEnvs());

describe("proxy (early sign-in check)", () => {
  it("lets everything through in demo mode", async () => {
    vi.stubEnv("HOMEPILOT_MODE", "demo");
    const res = await proxy(new NextRequest("http://127.0.0.1:3000/spend"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("sends a live visitor without a session to /login", async () => {
    vi.stubEnv("HOMEPILOT_API_TOKEN", TOKEN);
    const res = await proxy(new NextRequest("http://127.0.0.1:3000/spend"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):3000\/login$/);
  });

  it("accepts a valid session and rejects a forged one", async () => {
    vi.stubEnv("HOMEPILOT_API_TOKEN", TOKEN);
    const good = await signSession(await sessionSecret({ apiToken: TOKEN }), Date.now() + 60_000);
    const ok = await proxy(new NextRequest("http://127.0.0.1:3000/", { headers: { cookie: `${SESSION_COOKIE}=${good}` } }));
    expect(ok.headers.get("location")).toBeNull();
    const forged = `${Date.now() + 60_000}.${"0".repeat(64)}`;
    const no = await proxy(new NextRequest("http://127.0.0.1:3000/", { headers: { cookie: `${SESSION_COOKIE}=${forged}` } }));
    expect(no.headers.get("location")).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):3000\/login$/);
  });
});
