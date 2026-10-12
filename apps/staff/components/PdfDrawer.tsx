"use client";
/* A printed document in the side drawer (plan 2026-10-13, Kamrul: previews open in a side drawer, not inline). A "View the
   printed copy" button opens it; `autoOpen` opens it as soon as a copy is printed — only where seeing the document is the
   point (the interim bill), never where the next step is on the screen behind (a reprint needs its button). */
import { useEffect, useState } from "react";
import { Button, DocFrame, Drawer } from "@setu/ui";
import { useSession } from "../lib/session";

export function PdfDrawer({ src, title, autoOpen = false }: { src: string | null; title: string; autoOpen?: boolean }) {
  const s = useSession();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (src && autoOpen) setOpen(true); }, [src, autoOpen]);
  if (!src) return null;
  return (
    <>
      <span><Button icon="eye" onClick={() => setOpen(true)} data-testid="view-printed">{s.t("printApp", "ui_view_printed")}</Button></span>
      <Drawer open={open} onClose={() => setOpen(false)} label={title} href={src} hrefLabel={s.t("printApp", "ui_new_tab")}>
        <DocFrame title={title} src={src} />
      </Drawer>
    </>
  );
}
