# ADR 0007 — Doctor's inbox acknowledgement and printed clinical documents

Date: 2026-10-03 · Status: accepted (Kamrul, 03/10/2026 — slice A12–A13 plan decisions D1–D4)

## Context
Walkthrough A12 asks for a results inbox on the doctor's phone, critical results first, where acknowledging can notify
the patient and works offline as "Not yet synced". A13 asks for an A5/A4 prescription print with a QR, and drafts that
cannot be printed (issue #19). Decision D10 of A8–A11 moved the lab report PDF here too.

The domain model has no acknowledgement: `screens.md` (results inbox) names a state "Report ack: unread →
acknowledged" that is in no machine. The inbox items exist already — the lab writes a doctor-inbox `Communication` on
every release, correction, withdrawal and cancellation (ADR 0006) — but a Communication row is guarded: it is never
deleted and only its delivery status moves. Printing exists for receipts (ReceiptPrint, DUPLICATE #n, public verify),
not for clinical documents.

## Decision
### INBOX_ITEM — new machine, stored as an append-only InboxAck row
```
unread ──acknowledge──▶ acknowledged
```
- An inbox item is a doctor-inbox Communication row; it has exactly one recipient (the ordering doctor, or the visit's
  doctor for a critical vital sign). Only that doctor acknowledges it, once.
- The acknowledgement is a new row `InboxAck` (communication, who, when, `notifyPatient`, the SMS it queued) — insert
  only, one per item (unique). "Unread" = no InboxAck row. The Communication is not touched.
- A report item whose report version has been superseded is not acknowledged ("a newer version exists"); the newer
  version has its own item.
- **"Seen + tell patient"** (decision D1) is allowed only for a released report and needs the patient's mobile. It queues
  an SMS (Communication kind `report-reviewed`, the facility's name only — no test, value or diagnosis) in the same
  transaction as the InboxAck; it is dispatched after the commit, like every lab SMS. An acknowledgement made offline
  waits in the device outbox ("Not yet synced"); nothing is sent until the server has stored it.
- New Communication kind `critical-vital` (doctor-inbox): written when a vitals batch holds a critical value and the
  visit has a doctor (decision 47 of A4–A5).

### Printed clinical documents
- A **prescription** is the printed form of a signed consultation note version (Composition `final` or `amended`). A
  `draft` or `queued` version never prints (server 422 `draft_not_printable`; the preview shows the watermark "খসড়া —
  বৈধ নয় · DRAFT", no QR). A `superseded` version does not print ("a newer version exists"); `entered-in-error` never.
- A **lab report** version prints while it is current (preliminary with its banner, final, corrected).
- Each printable version gets a random verify code (20 characters, the same generator as receipts) when it is first
  printed; the QR opens `/verify/rx/<code>` or `/verify/lr/<code>`. The printed code is the full code in groups of four:
  the print spec's 6-character code would be guessable, and the prescription page shows medicines.
- `DocumentPrint` rows (append-only, unique per document version and copy): copy 0 is the original; every later copy
  needs a reason (lost, jam, copy) and prints "অনুলিপি · DUPLICATE #n"; each print is audited (`print` / `reprint`)
  and the PDF is stored once through the Storage adapter.
- **Public verify** (no login, rate-limited, no-store), through SECURITY DEFINER lookups that return only:
  prescription — facility, doctor and BMDC number as stored, date, version status (current / superseded / withdrawn),
  patient initials, age and sex, medicine lines (decision D2); lab report — facility, report number and version, date,
  status, patient initials, age and sex, test names and values with flags (the report's own purpose).

## Consequences
- `machines.ts` gains INBOX_ITEM; `@setu/domain` gains `inbox.ts` (severity, order, acknowledge blockers) and
  `printing.ts` (print blockers, copies, verify status, initials), used by the routes and the screens.
- Migration adds InboxAck, DocumentPrint, verify codes on Composition and DiagnosticReport, the Communication kinds
  `report-reviewed` and `critical-vital`, and the lookups.
- The doctor-inbox Communication guard is unchanged.
