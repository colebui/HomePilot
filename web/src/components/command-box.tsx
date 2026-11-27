"use client";

import { useActionState, useRef } from "react";
import { sendCommand, type CommandState } from "@/app/actions";

const EXAMPLES = ["remind me to call mom at 6pm", "spent $23 at H-E-B", "what should I do with my free hour?", "tasks"];

/** Type to HomePilot exactly as you would text it. The reply comes from the real parser. */
export function CommandBox({ demo }: { demo: boolean }) {
  const [state, action, pending] = useActionState<CommandState, FormData>(sendCommand, { reply: null, error: null });
  const input = useRef<HTMLInputElement>(null);

  return (
    <div>
      <form action={action} className="flex gap-2">
        <label htmlFor="command" className="sr-only">
          Message HomePilot
        </label>
        <input
          ref={input}
          id="command"
          name="text"
          autoComplete="off"
          maxLength={1000}
          placeholder="Text HomePilot…"
          className="min-w-0 flex-1 rounded-xl border border-line bg-page px-3 py-2.5 text-sm outline-none placeholder:text-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-page transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => {
              if (input.current) {
                input.current.value = ex;
                input.current.focus();
              }
            }}
            className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-2 hover:border-line-strong hover:text-ink"
          >
            {ex}
          </button>
        ))}
      </div>
      <div aria-live="polite" className="mt-3 empty:hidden">
        {state.error && <p className="rounded-xl bg-critical-soft px-3 py-2 text-sm text-critical">{state.error}</p>}
        {state.reply && (
          <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
            <p className="whitespace-pre-line">{state.reply}</p>
            <p className="mt-1.5 text-xs text-ink-3">
              {state.understoodBy === "model"
                ? `Read by ${state.model ?? "a model"}`
                : state.understoodBy === "deterministic"
                  ? "Read by the built-in parser, no model call"
                  : "Not understood"}
              {demo && " · demo, nothing saved"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
