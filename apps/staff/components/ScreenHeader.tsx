"use client";
/* The page header for a module screen (plan 2026-10-13): the breadcrumb (module) and the title (screen) come from the
   same capability names the left nav shows, so every screen gets a header without new strings. */
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PageHeader } from "@setu/ui";
import { useSession } from "../lib/session";

export function ScreenHeader({ title, subtitle, actions, screen }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; screen?: string }) {
  const s = useSession(); const path = usePathname();
  const [, , mod, key] = path.split("/");
  const m = s.caps?.modules.find((x) => x.key === mod);
  const x = m?.screens.find((y) => y.key === (screen ?? key));
  const bn = s.lang === "bn";
  const crumbs = m ? (bn ? m.name_bn : m.name_en) : undefined;
  const name = title ?? (x ? (bn ? x.name_bn : x.name_en) : "");
  return <PageHeader crumbs={crumbs} title={name} subtitle={subtitle} actions={actions} />;
}
