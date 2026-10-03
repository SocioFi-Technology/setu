/* Dose labels through the browser's print dialog (Kamrul 03/10/2026, ADR 0009): one label-sized page per label — the
   facility's page size (default 50 × 30 mm) — so any thermal label printer with an OS driver works. Built as plain DOM
   with text nodes only (a name never becomes markup); removed again after printing. Direct printer protocols (ZPL /
   TSPL) come only when a pilot clinic names its printer. */
export interface DoseLabelData { medicine: string; qty: string; dose: string; patient: string; batches: string; facility: string; date: string }

export function printDoseLabels(labels: DoseLabelData[], page: { widthMm: number; heightMm: number }) {
  const root = document.createElement("div");
  root.className = "label-print-root";
  root.setAttribute("data-testid", "label-print");
  root.setAttribute("data-page", `${page.widthMm}x${page.heightMm}`);
  const style = document.createElement("style");
  style.textContent = `
    @page { size: ${page.widthMm}mm ${page.heightMm}mm; margin: 0; }
    @media screen { .label-print-root { display: none; } }
    @media print {
      body > *:not(.label-print-root) { display: none !important; }
      .label-print-root { display: block; }
      .label-page { width: ${page.widthMm}mm; height: ${page.heightMm}mm; box-sizing: border-box; padding: 1.5mm 2mm; overflow: hidden;
        break-after: page; page-break-after: always; display: flex; flex-direction: column; gap: 0.6mm; color: #000; background: #fff;
        font-family: "Noto Sans Bengali", "Hind Siliguri", system-ui, sans-serif; font-size: 7pt; line-height: 1.2; }
      .label-page .m { font-weight: 700; font-size: 8pt; }
      .label-page .d { font-size: 8.5pt; font-weight: 600; }
      .label-page .f { margin-top: auto; font-size: 6pt; }
    }`;
  for (const l of labels) {
    const p = document.createElement("div");
    p.className = "label-page";
    const row = (cls: string, text: string) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; p.appendChild(d); };
    row("m", `${l.medicine} × ${l.qty}`);
    row("d", l.dose);
    row("p", l.patient);
    row("b", l.batches);
    row("f", `${l.facility} · ${l.date}`);
    root.appendChild(p);
  }
  document.head.appendChild(style);
  document.body.appendChild(root);
  const done = () => { root.remove(); style.remove(); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  // some browsers return from print() without an afterprint event
  setTimeout(done, 60_000);
}
