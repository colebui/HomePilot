import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ActivitySchema,
  AgendaSchema,
  ApprovalsSchema,
  HealthSchema,
  InsightsSchema,
  RemindersSchema,
  SayResultSchema,
  SpendingSchema,
  TasksSchema,
  UsageReportSchema,
} from "@/lib/homepilot/schemas";

/**
 * Contract test: the dashboard's schemas must accept what the service really sends.
 * The fixture is written by `npm run api-samples` in the repository root, which runs the real
 * service offline. CI regenerates it before running these tests, so a service change that breaks
 * the dashboard fails here.
 */
const samples = JSON.parse(readFileSync(new URL("./fixtures/api-samples.json", import.meta.url), "utf8")) as Record<string, unknown>;

const ROUTES = {
  "/api/health": HealthSchema,
  "/api/usage": UsageReportSchema,
  "/api/agenda": AgendaSchema,
  "/api/tasks": TasksSchema,
  "/api/approvals": ApprovalsSchema,
  "/api/insights": InsightsSchema,
  "/api/activity": ActivitySchema,
  "/api/reminders": RemindersSchema,
  "/api/spending": SpendingSchema,
  "POST /api/say": SayResultSchema,
} as const;

describe("service contract", () => {
  it.each(Object.entries(ROUTES))("%s matches the dashboard schema", (route, schema) => {
    expect(samples[route], `missing sample for ${route}`).toBeDefined();
    const parsed = schema.safeParse(samples[route]);
    if (!parsed.success) throw new Error(`${route}: ${JSON.stringify(parsed.error.issues.slice(0, 3), null, 2)}`);
  });

  it("covers every route the dashboard reads", () => {
    expect(Object.keys(samples).sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it("samples are not trivially empty", () => {
    expect((samples["/api/agenda"] as unknown[]).length).toBeGreaterThan(0);
    expect((samples["/api/activity"] as unknown[]).length).toBeGreaterThan(0);
    expect((samples["/api/spending"] as { recent: unknown[] }).recent.length).toBeGreaterThan(0);
  });
});
