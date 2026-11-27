import { expect, test, type Page } from "@playwright/test";

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

for (const [path, heading] of [
  ["/", /Good (morning|afternoon|evening)/],
  ["/upcoming", "Upcoming"],
  ["/activity", "Activity"],
  ["/spend", "Spending"],
] as const) {
  test(`${path} renders without errors or sideways scrolling`, async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText("Demo with made-up data.")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test("a command gets a reply", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Message HomePilot").fill("spent $5 on coffee");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/demo, so nothing was saved/)).toBeVisible();
});

test("marking a task done removes it from Today", async ({ page }) => {
  await page.goto("/");
  const today = page.locator("section", { has: page.getByRole("heading", { name: "Today", exact: true }) });
  const first = today.getByRole("button", { name: /^Mark ".+" done$/ }).first();
  const label = await first.getAttribute("aria-label");
  await first.click();
  await expect(page.getByRole("button", { name: label! })).toHaveCount(0);
});

test("the activity filter narrows the feed", async ({ page }) => {
  await page.goto("/activity?show=money");
  await expect(page.getByRole("link", { name: "Money" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByText(/^\$\d+\.\d{2}/).first()).toBeVisible();
});

test("the spending chart explains a bar on hover", async ({ page, isMobile }) => {
  test.skip(isMobile, "hover only");
  await page.goto("/spend");
  const bar = page.getByRole("button", { name: /: \$\d/ }).last();
  await bar.hover();
  await expect(page.getByRole("status").first()).toBeVisible();
});
