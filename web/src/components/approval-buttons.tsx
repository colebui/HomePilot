"use client";

import { useState, useTransition } from "react";
import { decideApproval } from "@/app/actions";

export function ApprovalButtons({ code }: { code: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  if (result) return <p className="text-xs text-ink-2">{result}</p>;
  const decide = (d: "approve" | "deny") =>
    start(async () => {
      const r = await decideApproval(code, d);
      setResult(r.error ?? r.reply ?? "Done.");
    });
  return (
    <div className="flex gap-2">
      <button type="button" disabled={pending} onClick={() => decide("approve")} className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-page disabled:opacity-50">
        Approve
      </button>
      <button type="button" disabled={pending} onClick={() => decide("deny")} className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-2 hover:text-ink disabled:opacity-50">
        Deny
      </button>
    </div>
  );
}
