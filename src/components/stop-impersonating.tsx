"use client";
import { authClient } from "@/lib/auth-client";

export function StopImpersonating() {
  return (
    <button
      type="button"
      className="btn small"
      onClick={async () => {
        await authClient.admin.stopImpersonating();
        window.location.href = "/admin";
      }}
    >
      Return to admin
    </button>
  );
}
