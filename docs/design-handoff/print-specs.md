# Print template specs

All templates: black text on white, flags and QR in black ink only (photocopy-safe). Body font Noto Sans Bengali for Bangla, IBM Plex Sans for Latin; numbers use tabular figures. Bangla lines use the `-lh-bn` leading. Nothing prints with a QR until the document is **final**; drafts print a diagonal "খসড়া — বৈধ নয় · DRAFT" watermark at 10% black and printing may be disabled by policy. Reprints add "অনুলিপি · DUPLICATE #n" and an AuditEvent. Reference: `design/Setu DS 6 Print Templates.dc.html`, `design/Setu Consultation.dc.html` (Rx preview), `design/Setu Billing.dc.html` (receipts), `design/Setu Admin.dc.html` (template designer).

| Template | Paper | Margins (T/R/B/L) | Body / small / title | Header | QR | Footer |
|---|---|---|---|---|---|---|
| Prescription A5 | 148 × 210 mm portrait | 12 / 10 / 12 / 10 mm | 11 pt / 9 pt / 14 pt | logo 16 mm, facility bn+en, doctor name, degrees, BMDC no., chamber hours; 0.5 pt rule | 18 mm, bottom-left, + 6-char code | signature block right, follow-up date, "Verify at verify.setu…" |
| Prescription A4 | 210 × 297 mm | 15 / 15 / 15 / 15 mm | 12 pt / 10 pt / 16 pt | as A5, two-column doctor details | 22 mm bottom-left | as A5 |
| Receipt thermal 80 mm | 72 mm printable width, continuous | 3 / 3 / 6 / 3 mm | 9 pt mono-spaced figures / 8 pt / 11 pt bold | facility name, BIN, address, counter, cashier | 24 mm centred at end | amount in words bn + en, payment refs (TrxID), "Thank you" |
| Receipt / VAT invoice A5 (Mushak-6.3) | 148 × 210 mm | 10 / 10 / 10 / 10 mm | 10 pt / 8.5 pt / 13 pt | seller name, BIN, address; buyer; invoice no + date + time | 18 mm top-right | VAT breakdown per rate, totals, words, signature |
| Lab report A4 | 210 × 297 mm | 15 / 15 / 18 / 15 mm | 11 pt / 9 pt / 15 pt | logo, lab name bn+en, accreditation; patient block (name, age/sex, patient no, referred by, sample/collected/reported times) | 22 mm bottom-left | technologist + pathologist signatures, page x/y, "PRELIMINARY" or "FINAL", amended banner "Amended report — version 2" |
| Discharge summary A4 | 210 × 297 mm | 15 / 15 / 18 / 15 mm | 11 pt / 9 pt / 15 pt | as lab report + admission/discharge dates, bed | 22 mm bottom-left | consultant signature, follow-up, emergency contact |
| Barcode label | 50 × 25 mm | 2 mm | 8 pt | patient name (short), age/sex, patient no | Code 128 barcode 40 × 10 mm | tube colour + tests |

Admin › Print designer settings stored per facility: language (bn + en | bn | en), QR position (footer | header), body size (12 | 13 | 14 pt screen preview ≙ 10–12 pt print), colour header band on/off, logo. VAT invoice layout is configurable per facility (Mushak form version).
