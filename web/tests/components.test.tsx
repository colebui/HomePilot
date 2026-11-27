// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const completeTask = vi.fn();
vi.mock("@/app/actions", () => ({ completeTask: (id: string) => completeTask(id) }));

const { TaskList } = await import("@/components/task-list");
const { BarChart } = await import("@/components/bar-chart");

afterEach(() => {
  cleanup();
  completeTask.mockReset();
});

describe("TaskList", () => {
  const tasks = [
    { id: "t1", title: "Call the dentist", time: "10:30 AM" },
    { id: "t2", title: "Pay the water bill", time: "By end of day", overdue: true },
  ];

  it("hides a task as soon as it is marked done", async () => {
    completeTask.mockResolvedValue({ ok: true });
    render(<TaskList tasks={tasks} empty="Nothing" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: 'Mark "Call the dentist" done' })));
    expect(completeTask).toHaveBeenCalledWith("t1");
    expect(screen.queryByText("Call the dentist")).not.toBeInTheDocument();
  });

  it("shows the service's refusal", async () => {
    completeTask.mockResolvedValue({ ok: false, error: "HomePilot is not reachable" });
    render(<TaskList tasks={tasks} empty="Nothing" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: 'Mark "Pay the water bill" done' })));
    expect(await screen.findByRole("alert")).toHaveTextContent("HomePilot is not reachable");
  });

  it("shows the empty message", () => {
    render(<TaskList tasks={[]} empty="Nothing else due today." />);
    expect(screen.getByText("Nothing else due today.")).toBeInTheDocument();
  });
});

describe("BarChart", () => {
  const points = [
    { key: "a", label: "Nov 1", value: 12, detail: "Sun, Nov 1: $12.00" },
    { key: "b", label: "Nov 2", value: 30, detail: "Mon, Nov 2: $30.00" },
  ];

  it("has a tooltip on hover and a table for screen readers", () => {
    render(<BarChart points={points} format="usd" label="Spending per day" />);
    expect(screen.getByRole("table")).toHaveTextContent("Mon, Nov 2: $30.00");
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Mon, Nov 2: $30.00" }));
    expect(screen.getByRole("status")).toHaveTextContent("$30.00");
  });
});
