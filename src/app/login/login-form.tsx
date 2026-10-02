"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="form-grid"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setPending(true);
        const data = new FormData(e.currentTarget);
        const { error } = await authClient.signIn.email({ email: String(data.get("email")).trim(), password: String(data.get("password")) });
        if (error) {
          setPending(false);
          setError(error.status === 429 ? "Too many attempts. Wait a few minutes and try again." : "That email and password don't match an account.");
          return;
        }
        window.location.href = "/";
      }}
    >
      <label className="f">
        Email
        <input type="email" name="email" autoComplete="username" required autoFocus />
      </label>
      <label className="f">
        Password
        <input type="password" name="password" autoComplete="current-password" required />
      </label>
      <div aria-live="polite">{error ? <p className="alert bad" role="alert">{error}</p> : null}</div>
      <button className="btn lg" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
