import { describe, expect, it } from "vitest";
import { niceMax } from "@/components/bar-chart";
import { greeting, localDateKey, modelName, ms, percent, relative, usd } from "@/lib/format";
import { buildDemoSnapshot } from "@/lib/homepilot/demo";
import { parseEnv } from "@/lib/server/env";
import { safeEqual, sessionSecret, signSession, verifySession } from "@/lib/server/session";
import { paceStatus, summarizeModelCost, summarizePersonal } from "@/lib/spend";

describe("format", () => {
  it("shows tiny model costs honestly and big ones normally", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.000331)).toBe("$0.00033");
    expect(usd(0.0096)).toBe("$0.0096");
    expect(usd(12.4)).toBe("$12.40");
    expect(usd(3147.55)).toBe("$3,147.55");
    expect(usd(-5)).toBe("-$5.00");
  });

  it("formats percents, durations and model names", () => {
    expect(percent(0.834)).toBe("83%");
    expect(percent(null)).toBe("–");
    expect(ms(640)).toBe("640 ms");
    expect(ms(1850)).toBe("1.9 s");
    expect(modelName("deepseek/deepseek-v4.1-flash-1017")).toBe("deepseek-v4.1-flash-1017");
  });

  it("works in the service's time zone, not the browser's", () => {
    // 03:30 UTC on Nov 17 is still Nov 16 in Chicago.
    expect(localDateKey("2026-11-17T03:30:00Z", "America/Chicago")).toBe("2026-11-16");
    expect(greeting("2026-11-16T15:00:00Z", "America/Chicago")).toBe("Good morning");
    expect(greeting("2026-11-16T21:00:00Z", "America/Chicago")).toBe("Good afternoon");
    expect(greeting("2026-11-16T23:00:00Z", "America/Chicago")).toBe("Good evening");
  });

  it("says relative times in plain words", () => {
    const now = new Date("2026-11-16T15:00:00Z");
    expect(relative("2026-11-16T15:25:00Z", now)).toBe("in 25 min");
    expect(relative("2026-11-16T12:00:00Z", now)).toBe("3 h ago");
    expect(relative("2026-11-19T15:00:00Z", now)).toBe("in 3 days");
    expect(relative("2026-11-16T15:00:20Z", now)).toBe("just now");
  });

  it("rounds chart axes to readable values", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(1611)).toBe(2000);
    expect(niceMax(0.0083)).toBeCloseTo(0.01, 10);
    expect(niceMax(230)).toBe(250);
  });
});

describe("spend summaries", () => {
  it("calls the pace by the projection, not only by what is spent so far", () => {
    expect(paceStatus(0.3, 0.6)).toBe("on_track");
    expect(paceStatus(0.5, 0.85)).toBe("watch");
    expect(paceStatus(0.6, 1.2)).toBe("over");
    expect(paceStatus(1.01, null)).toBe("over");
  });

  it("projects personal spending to month end in the right time zone", () => {
    const now = new Date("2026-11-16T15:00:00Z"); // day 16 of a 30-day month
    const snap = buildDemoSnapshot(now);
    const me = summarizePersonal(snap.spending, now, "America/Chicago");
    expect(me.projectedUsd).toBeCloseTo((snap.spending.summary.totalUsd / 16) * 30, 6);
    expect(me.usedFraction).toBeCloseTo(snap.spending.summary.totalUsd / snap.spending.budgetUsd, 10);
  });

  it("derives model cost per text and the share of texts that needed no model", () => {
    const snap = buildDemoSnapshot(new Date("2026-11-16T15:00:00Z"));
    const ai = summarizeModelCost(snap.usage, snap.insights);
    expect(ai.freeShare).toBeCloseTo(snap.insights.texts.deterministic / snap.insights.texts.handled, 10);
    expect(ai.costPerTextUsd).toBeCloseTo(ai.monthUsd / snap.insights.texts.handled, 12);
    expect(ai.savedFraction).toBeGreaterThan(0);
  });
});

describe("sessions", () => {
  it("accepts its own signature until it expires", async () => {
    const secret = await sessionSecret({ apiToken: "token-0123456789abcdef" });
    const value = await signSession(secret, 2_000_000_000_000);
    expect(await verifySession(secret, value, 1_900_000_000_000)).toBe(true);
    expect(await verifySession(secret, value, 2_000_000_000_001)).toBe(false);
  });

  it("rejects tampering, other secrets and junk", async () => {
    const secret = await sessionSecret({ apiToken: "token-0123456789abcdef" });
    const value = await signSession(secret, 2_000_000_000_000);
    const extended = value.replace("2000000000000", "2999999999999");
    expect(await verifySession(secret, extended, 1_900_000_000_000)).toBe(false);
    expect(await verifySession(await sessionSecret({ apiToken: "another-token-0123456789" }), value, 1_900_000_000_000)).toBe(false);
    expect(await verifySession(secret, "nonsense", 0)).toBe(false);
    expect(await verifySession(secret, undefined, 0)).toBe(false);
  });

  it("compares passwords without short-circuiting on length", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("environment", () => {
  it("defaults to the demo unless a token is configured", () => {
    expect(parseEnv({}).HOMEPILOT_MODE).toBe("demo");
    expect(parseEnv({ HOMEPILOT_API_TOKEN: "token-0123456789abcdef" }).HOMEPILOT_MODE).toBe("live");
    expect(() => parseEnv({ HOMEPILOT_MODE: "live" })).toThrow(/HOMEPILOT_API_TOKEN/);
    expect(() => parseEnv({ HOMEPILOT_API_TOKEN: "short" })).toThrow();
  });
});
