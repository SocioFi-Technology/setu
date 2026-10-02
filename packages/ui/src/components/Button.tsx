"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  icon?: string;
  kbd?: string;
  children?: ReactNode;
}
export function Button({ variant = "default", size = "md", icon, kbd, children, className, ...rest }: ButtonProps) {
  const cls = ["btn", variant !== "default" && `btn-${variant}`, size === "lg" && "btn-lg", size === "sm" && "btn-sm", className].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} {...rest}>
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
      {kbd && <kbd className="kbd">{kbd}</kbd>}
    </button>
  );
}
export function IconButton({ icon, label, badge, ...rest }: { icon: string; label: string; badge?: string | number } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="btn-icon" aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={19} />
      {badge != null && badge !== "" && <span style={{ position: "absolute", top: 4, right: 3, minWidth: 18, height: 18, padding: "0 4px", borderRadius: "var(--radius-pill)", background: "var(--danger-solid)", color: "var(--danger-on-solid)", font: "700 10px/18px var(--font-sans)" }}>{badge}</span>}
    </button>
  );
}
