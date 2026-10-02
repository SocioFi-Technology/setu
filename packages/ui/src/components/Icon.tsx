"use client";
import * as L from "lucide-react";
import type { CSSProperties } from "react";

/** Lucide icon by its kebab-case name, as the prototype's `icon-*` font classes name them. */
export function Icon({ name, size = 16, style, className }: { name: string; size?: number; style?: CSSProperties; className?: string }) {
  const pascal = name.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  const Cmp = (L as unknown as Record<string, L.LucideIcon>)[pascal] ?? L.Circle;
  return <Cmp size={size} strokeWidth={2} aria-hidden style={{ flex: "none", ...style }} className={className} />;
}
