"use client";
import { useEffect, useState } from "react";

/**
 * The left menu. On desktop it's the fixed sidebar; on phones it's hidden behind a ☰ button in a slim
 * top bar and slides in from the left. Closes on ✕, the backdrop, Escape, or choosing a link.
 */
export function NavDrawer({ brand, children }: { brand: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <div className="mobilebar">
        <button type="button" className="menu-btn" aria-controls="main-nav" aria-expanded={open} onClick={() => setOpen(true)}>
          <span aria-hidden="true">☰</span> Menu
        </button>
        <div className="mobilebar-brand">{brand}</div>
      </div>
      <div className={`nav-backdrop${open ? " open" : ""}`} onClick={() => setOpen(false)} aria-hidden="true" />
      <nav
        id="main-nav"
        className={`nav${open ? " open" : ""}`}
        aria-label="Main"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) setOpen(false);
        }}
      >
        <button type="button" className="nav-close" aria-label="Close menu" onClick={() => setOpen(false)}>✕</button>
        {children}
      </nav>
    </>
  );
}
