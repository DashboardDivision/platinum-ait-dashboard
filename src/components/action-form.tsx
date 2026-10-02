"use client";
import { useActionState } from "react";

export type ActionState = { error?: string; ok?: string } | null;

/**
 * Wraps a server action with pending state and inline, announced errors.
 * Server actions are same-origin checked by Next.js (CSRF).
 */
export function ActionForm({
  action,
  children,
  submit,
  className,
  confirm,
  variant,
  size,
}: {
  action: (prev: ActionState, data: FormData) => Promise<ActionState>;
  children?: React.ReactNode;
  submit: string;
  className?: string;
  confirm?: string;
  variant?: "secondary" | "danger";
  size?: "small" | "lg";
}) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form
      action={run}
      className={className ?? "form-grid"}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <div aria-live="polite">
        {state?.error ? <p className="alert bad" role="alert">{state.error}</p> : null}
        {state?.ok ? <p className="alert ok">{state.ok}</p> : null}
      </div>
      <div>
        <button className={["btn", variant, size].filter(Boolean).join(" ")} type="submit" disabled={pending} aria-disabled={pending}>
          {pending ? "Working…" : submit}
        </button>
      </div>
    </form>
  );
}
