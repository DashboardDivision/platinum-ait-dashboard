"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Opens an outside site (study materials, exam scheduling) in a new tab so the dashboard stays open.
 * The tab is opened during the click (so it isn't popup-blocked), the click is recorded with a POST
 * (link previews and prefetch can't trigger it), then the tab is sent on. A form post can't do this:
 * the CSP's form-action 'self' also blocks the cross-site redirect after it, leaving a blank tab.
 */
export function OpenLinkForm({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function open() {
    setError(null);
    setPending(true);
    const tab = window.open("about:blank", "_blank");
    try {
      const res = await fetch(href, { method: "POST", headers: { accept: "application/json" } });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error || "That link couldn't be opened. Try again.");
      if (tab) {
        tab.opener = null;
        tab.location.href = body.url;
      } else {
        window.location.href = body.url; // popups blocked: open it here instead
      }
      router.refresh();
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : "That link couldn't be opened. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button className={className} type="button" onClick={open} disabled={pending} aria-disabled={pending}>{children}</button>
      {error ? <p className="alert bad" role="alert" style={{ marginTop: 8 }}>{error}</p> : null}
    </div>
  );
}
