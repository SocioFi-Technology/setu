"use client";
import { useEffect, type ReactNode } from "react";
import { Shell } from "../../components/Shell";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
export default function ShellLayout({ children }: { children: ReactNode }) {
  const s = useSession();
  /* No valid session (expired, or the cookie was signed with another secret): clear the cookie first, otherwise
     the middleware sees a cookie and sends us straight back here. */
  useEffect(() => { if (!s.loading && !s.me) api.logout().catch(() => {}).finally(() => { location.href = "/login"; }); }, [s.loading, s.me]);
  if (s.loading || !s.me) return <div style={{ padding: 32 }} className="t-muted">…</div>;
  return <Shell>{children}</Shell>;
}
