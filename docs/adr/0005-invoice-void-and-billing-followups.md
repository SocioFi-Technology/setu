# ADR 0005 — Voiding a bill (INVOICE entered-in-error), "Not billed here", payment reconciliation

Date: 2026-10-03 · Status: accepted (Kamrul, 03/10/2026 — billing follow-ups after slice A6–A7, decisions 1–8)

## Decision
### INVOICE gains `entered-in-error`
```
draft  ──markError(reason)──▶ entered-in-error
issued ──markError(reason)──▶ entered-in-error
```
- Owner or admin only, with a reason of at least 10 characters; never a delete. Who, when and why are stored on the
  bill and in an AuditEvent.
- Refused while any money is confirmed on the bill (partially-paid and balanced bills cannot be voided at all —
  refunds are a later slice) and while a wallet link is still pending ("cancel the link first").
- A voided bill keeps its INV number; numbers are never reused. The visit may get a new draft bill: the new bill
  records which bill it replaces, and once the new one is issued the voided bill shows "Replaced by INV/…".
- Any PDF of a voided bill is stamped VOID. (Today a voided bill can never have a receipt, because a void is refused
  once money is confirmed; the stamp is the guard for when refunds arrive.)
- The existing `cancel` event (domain-model "cancelled(approval)") stays in the table but is not used by any route; the
  database refuses it until a slice defines it.

### "Not billed here" (decision 98) — an APPROVAL Task, kind `bill-elsewhere`
A cashier may ask to exclude an **unpriced order line** with a reason (≥10). Same rules as a discount approval: owner or
admin decides, never their own request, and the bill cannot be issued while it is requested. Approved → the line stays
on the bill and the receipt as "Not billed here — <reason>", outside totals and VAT; the ServiceRequest stays active.
No new state machine: APPROVAL `requested → approved | rejected`.

### Payment reconciliation (decisions 89, 101) — the owner's queue `bill/reconcile`
Tasks of kind `payment-reconciliation` (late money on a failed or replaced link, an amount that differs, a second
payment on a confirmed one, a TrxID paid on a replaced link). The owner either **applies** the money to the bill —
only when the provider, asked again, confirms the same amount and TrxID for a payment of this bill that is still
pending (any newer link is then cancelled) — or **marks it resolved** with a note (≥10). Never a silent apply. APPROVAL
`approve` = applied, `reject` = resolved with a note; the outcome is stored on the Task.

**`bill/reconcile` is a screen beyond the design handoff** (`shell-roles-plans.md` has no such screen). It is added to
`packages/domain/src/access-matrix.json` by hand (Billing module, owner only, Clinic plan) with a test that keeps it
there; **the prototype gets it in the next design round.**

### Order refresh on a draft bill (decision 99 prep)
When a draft bill is opened, its order lines are brought in line with the visit's placed orders: a line whose order is
no longer active is removed and a newly placed order (an amended note) is added. If a discount is on the bill or
waiting for approval, nothing is recalculated silently: Issue is blocked with "orders changed — remove the discount,
then reopen". The lab slice adds ORDER `revoke`.

## Why
A wrong bill must be correctable without deleting anything (rule 3, amend never overwrite, applied to money). A test
the facility cannot price must not block the consultation fee, and must not be waved away by one person. Money reported
by a gateway in an unusual way must reach a person, never be applied by the system on a guess.

## Consequences
- Migration `billing_followups`: enum value, void and replacement columns on Invoice, exclusion columns on ChargeItem,
  updated guards (issue ignores approved exclusions and is refused while one is requested; void only without confirmed
  money or pending payments; one open bill per visit counts neither cancelled nor voided bills).
- Refunds, and voiding a bill that holds money, are open questions for a later slice.
- Tests: `machines.test.ts` covers INVOICE `markError` from every state.
