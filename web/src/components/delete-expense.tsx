"use client";

import { useState, useTransition } from "react";
import { deleteExpense } from "@/app/actions";

export function DeleteExpenseButton({ id, label }: { id: string; label: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      title={error ? "Could not delete it" : "Delete this expense"}
      aria-label={`Delete ${label}`}
      onClick={() =>
        start(async () => {
          const r = await deleteExpense(id);
          setError(!r.ok);
        })
      }
      className={`rounded-md px-2 py-1 text-xs ${error ? "text-critical" : "text-ink-3 hover:bg-surface-2 hover:text-ink"} disabled:opacity-50`}
    >
      {pending ? "…" : error ? "Retry" : "Delete"}
    </button>
  );
}
