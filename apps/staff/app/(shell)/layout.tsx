"use client";
import { useEffect, type ReactNode } from "react";
import { Shell } from "../../components/Shell";
import { api } from "../../lib/api";
import { clearDraftsForLastOwner } from "../../lib/outbox";
import { useSession } from "../../lib/session";
export default function ShellLayout({ children }: { children: ReactNode }) {
  const s = useSession();
  /* No valid session (expired, or the cookie was signed with another secret): clear the cookie first, otherwise
     the middleware sees a cookie and sends us straight back here. */
  // An expired session counts as a sign-out for device drafts (security review A5: nothing left on a shared PC).
  useEffect(() => {
    if (s.loading || s.me) return;
    // Online only: an offline reload also lands here, and must not wipe the drafts kept for exactly that case.
    if (navigator.onLine) clearDraftsForLastOwner();
    api.logout().catch(() => {}).finally(() => { location.href = "/login"; });
  }, [s.loading, s.me]);
  if (s.loading || !s.me) return <div style={{ padding: 32 }} className="t-muted">…</div>;
  return <Shell>{children}</Shell>;
}
