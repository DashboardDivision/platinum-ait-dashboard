"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function ForgotForm() {
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  if (done)
    return (
      <p className="alert ok" role="status">
        If that email has a dashboard account, we sent a reset link. It works once and expires in an hour.
      </p>
    );
  return (
    <form
      className="form-grid"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        const email = String(new FormData(e.currentTarget).get("email")).trim();
        // Same response whether or not the account exists.
        await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" }).catch(() => null);
        setDone(true);
      }}
    >
      <label className="f">
        Email
        <input type="email" name="email" autoComplete="username" required autoFocus />
      </label>
      <button className="btn lg" type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
