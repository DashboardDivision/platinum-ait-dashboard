"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function ResetForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  if (done)
    return (
      <p className="alert ok" role="status">
        Your password is updated. <a href="/login">Sign in</a> with your new password.
      </p>
    );
  return (
    <form
      className="form-grid"
      onSubmit={async (e) => {
        e.preventDefault();
        const d = new FormData(e.currentTarget);
        const pw = String(d.get("password"));
        if (pw !== String(d.get("confirm"))) return setError("The two passwords don't match.");
        setPending(true);
        setError(null);
        const { error } = await authClient.resetPassword({ newPassword: pw, token });
        setPending(false);
        if (error) return setError(error.message?.includes("phone") || error.message?.includes("numbers") ? error.message : "This link has expired or was already used. Ask for a new one.");
        setDone(true);
      }}
    >
      <label className="f">
        New password <span className="hint">At least 10 characters. Not your phone number.</span>
        <input type="password" name="password" autoComplete="new-password" minLength={10} required autoFocus />
      </label>
      <label className="f">
        Confirm new password
        <input type="password" name="confirm" autoComplete="new-password" minLength={10} required />
      </label>
      <div aria-live="polite">{error ? <p className="alert bad" role="alert">{error}</p> : null}</div>
      <button className="btn lg" type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save new password"}
      </button>
    </form>
  );
}
