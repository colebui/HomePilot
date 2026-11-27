"use client";

import { useOptimistic, useState, useTransition } from "react";
import { completeTask } from "@/app/actions";

export interface TaskRow {
  id: string;
  title: string;
  time: string;
  overdue?: boolean;
}

/** Tasks with a Done button. The row disappears at once and comes back if the service says no. */
export function TaskList({ tasks, empty }: { tasks: TaskRow[]; empty: string }) {
  // `confirmed` keeps a finished task hidden even if the refreshed list arrives a moment later.
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [done, markDone] = useOptimistic<string[], string>(confirmed, (s, id) => [...s, id]);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const visible = tasks.filter((t) => !done.includes(t.id));

  if (visible.length === 0) return <p className="rounded-xl bg-surface-2 px-4 py-6 text-center text-sm text-ink-2">{empty}</p>;

  return (
    <div>
      <ul className="divide-y divide-line">
        {visible.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-2.5">
            <button
              type="button"
              aria-label={`Mark "${t.title}" done`}
              onClick={() =>
                start(async () => {
                  markDone(t.id);
                  const r = await completeTask(t.id);
                  if (r.ok) setConfirmed((c) => [...c, t.id]);
                  setError(r.ok ? null : (r.error ?? "Could not mark it done."));
                })
              }
              className="grid size-5 shrink-0 place-items-center rounded-full border-2 border-line-strong transition-colors hover:border-good hover:bg-good-soft"
            />
            <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
            <span className={`tabular shrink-0 text-xs ${t.overdue ? "font-medium text-critical" : "text-ink-2"}`}>{t.time}</span>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-sm text-critical">
          {error}
        </p>
      )}
    </div>
  );
}
