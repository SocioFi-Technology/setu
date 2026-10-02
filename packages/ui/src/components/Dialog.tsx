"use client";
import { useEffect, type ReactNode } from "react";
export function Dialog({ open, onClose, label, children, width }: { open: boolean; onClose: () => void; label: string; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="scrim" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={label} className="dialog" style={width ? { width } : undefined} onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
