# Component inventory

Every component reads colours, type and spacing from `tokens/`. Reference implementations live in `design/Setu DS 2–6 *.dc.html`.

## Button
- **Reference:** ds/Actions
- **Props / variants:** variant: primary|accent|secondary|ghost|danger|split; size: sm 32|md 40|lg 48|touch 52; icon?: LucideName; iconOnly?: boolean; loading?: boolean
- **States:** default, hover, active, focus-visible, disabled, loading (spinner + label kept)
- **Accessibility:** Accent (marigold) only for the single key action per screen (Sign, Pay, Start). Icon-only buttons need aria-label + tooltip. Disabled buttons keep a visible reason nearby.
- **Used by:** all

## IconButton + Tooltip
- **Reference:** ds/Actions
- **Props / variants:** icon; label (tooltip + aria-label); shortcut?
- **States:** default, hover, focus, disabled
- **Accessibility:** Tooltip on hover AND focus; shows keyboard shortcut.
- **Used by:** shell, consult, billing, lab

## TextField
- **Reference:** ds/Actions
- **Props / variants:** label (bn · en); hint; error; required; prefix/suffix; size md 40 | touch 48 | vitals 56
- **States:** default, hover, focus, disabled, read-only, error, loading
- **Accessibility:** Label always visible (no placeholder-only labels). Error text + icon below field, linked with aria-describedby.
- **Used by:** all forms

## BilingualNameField
- **Reference:** ds/Actions
- **Props / variants:** valueBn; valueEn; transliterate?: boolean; source chip
- **States:** default, focus, error (either script missing), source changed
- **Accessibility:** Two inputs with lang="bn" / lang="en"; source chip is a button with its own label.
- **Used by:** frontDesk.register, erOt.unknown, patientApp.family

## PhoneField (+880)
- **Reference:** ds/Actions
- **Props / variants:** value; owner: self|guardian|spouse|other; masks 1XXX-XXXXXX
- **States:** default, focus, invalid operator prefix, error
- **Accessibility:** inputmode="tel"; announces format.
- **Used by:** frontDesk, doctorApp.onboard, patientApp.onboard

## DateAgeField
- **Reference:** ds/Actions
- **Props / variants:** mode: dob|approx; value DD/MM/YYYY; shows y/m/d age
- **States:** default, approximate (dashed amber + "approx." text), future date error
- **Accessibility:** Approximate age is labelled in text, not just by the dashed border.
- **Used by:** frontDesk.register, erOt.unknown, patientApp.family

## MoneyField (৳)
- **Reference:** ds/Actions
- **Props / variants:** value; min/max; showWords: bn|en|both
- **States:** default, focus, over limit, error
- **Accessibility:** Shows amount in words live; tabular figures; South Asian grouping on blur.
- **Used by:** billing, ipd.admit, admin

## DosePatternField
- **Reference:** ds/Actions
- **Props / variants:** slots: 3|4 (morning/noon/night[/bedtime]); values 0–3 or ½; meal: before|after|with; days
- **States:** default, focus per slot, invalid (all zero), read-only
- **Accessibility:** Keyboard: digits + ← →; renders "১+০+১" per numeral setting; each slot has its own aria-label.
- **Used by:** consult, doctorApp.consult, ipd.summary, patientApp.rx (read-only pictogram)

## SearchField + Results
- **Reference:** ds/Actions
- **Props / variants:** detects phone | name bn/en | patient no | QR; results list with highlight
- **States:** idle, typing, loading, results, no results, error, offline (local cache badge)
- **Accessibility:** Combobox pattern (aria-activedescendant); ↑↓ Enter; results announce count.
- **Used by:** frontDesk.search, shell command palette, consult Rx search

## Select / MultiSelect / Chips
- **Reference:** ds/Actions
- **Props / variants:** options; multiple; chips removable
- **States:** default, open, focus, disabled, error
- **Accessibility:** Native select on mobile. Chips have remove button with label.
- **Used by:** all

## Toggle / Segmented
- **Reference:** ds/Actions
- **Props / variants:** options 2–5; value
- **States:** default, hover, focus, disabled
- **Accessibility:** role="radiogroup"; state conveyed by text, not colour only.
- **Used by:** all

## FileUpload + Camera
- **Reference:** ds/Actions
- **Props / variants:** accept; camera: boolean; compress on slow network
- **States:** empty, dragging, uploading (progress), queued offline, uploaded, failed-retry
- **Accessibility:** Upload result carries "Uploaded — not verified" provenance.
- **Used by:** frontDesk.register, lab.intake, patientApp.upload

## DataTable
- **Reference:** ds/DataTable
- **Props / variants:** columns (chooser); density: comfortable 48 | compact 36; stickyHeader; stickyTotals; inlineEdit; bulkActions; pagination; filters
- **States:** loading (skeleton rows), empty (with next action), error, partial selection, editing row
- **Accessibility:** Grid role with roving tabindex; ↑↓←→ Enter to edit, Esc to cancel; row status badge = text + colour.
- **Used by:** billing, lab, pharmacy, admin, owner drill-down

## PatientHeaderBanner
- **Reference:** ds/Clinical
- **Props / variants:** context: opd|ipd|lab|pharmacy|billing|mobile; patient {nameBn,nameEn,age,sex,patientNo,photo}; allergies[]; identity: verified|unverified|possibleDuplicate|provisional; payer; location/bed; alerts[]
- **States:** normal, unverified identity (amber warning row), possible duplicate (warning + "Review"), no allergies recorded (explicit text), loading, restricted (permission)
- **Accessibility:** Allergy strip is always visible and never collapses; red + icon + text. Identity warning uses text, never colour alone.
- **Used by:** every clinical screen

## ProvenanceBadge
- **Reference:** ds/Clinical
- **Props / variants:** kind: verified|uploaded|patientReported|aiDraft; author; organisation; recordedAt
- **States:** default, popover open (hover/tap/focus)
- **Accessibility:** Badge has text; popover is keyboard reachable; AI draft uses dashed border + "unverified".
- **Used by:** consult, network, patientApp.timeline, lab

## StatusPill
- **Reference:** ds/Clinical
- **Props / variants:** status: draft|pending|inProgress|partiallyComplete|signed|final|amended|cancelled|critical|offline|syncing|failedRetry
- **States:** static; syncing animates icon only
- **Accessibility:** Always icon + text; draft uses hatched background.
- **Used by:** all

## ResultRow
- **Reference:** ds/Clinical
- **Props / variants:** analyte; value; unit; refRange (age/sex aware); flag: N|H|L|HH|LL|critical; delta?; source: analyser|manual
- **States:** normal, high, low, critical, pending, amended (shows previous value)
- **Accessibility:** Flag rendered as letter + arrow icon + colour; critical adds "!!" and siren icon.
- **Used by:** lab.result, lab.report, consult history, patientApp.report

## TimelineItem
- **Reference:** ds/Clinical
- **Props / variants:** type: visit|labReport|prescription|admission|document; date; facility; provenance
- **States:** default, selected, restricted (locked row), draft
- **Accessibility:** List semantics; dashed card for patient-supplied items.
- **Used by:** consult history, patientApp.timeline, network.shared

## QueueTokenCard / BedCard / WorklistCard
- **Reference:** ds/Clinical
- **Props / variants:** token/bed/worklist item; state; badges
- **States:** each state carries text + icon; bed: vacant|occupied|reserved|cleaning|blocked|dischargePending
- **Accessibility:** Cards are buttons or links, 44/48px min height; bed "blocked" uses hatch pattern.
- **Used by:** frontDesk.queue, ipd.map, nursing.ward, lab

## SignOffModal
- **Reference:** ds/Overlays
- **Props / variants:** items that become final; confirm identity (PIN); aiReviewed checkbox when AI text present
- **States:** idle, missing PIN, submitting, waiting for server, confirmed, failed
- **Accessibility:** Lists exactly what becomes final; nothing shows "Signed" until server confirms. Focus trapped; Esc cancels.
- **Used by:** consult, lab.verify, ipd.summary, nursing.handover

## ApprovalModal
- **Reference:** ds/Overlays
- **Props / variants:** kind: discount|concession|refund|cancel; amount; reason (required); approver
- **States:** draft, pending, approved, rejected (needs note)
- **Accessibility:** Reason required before submit; shows policy limit in text.
- **Used by:** billing, owner (mobile), admin.limits

## PermissionDenied / BreakGlassPanel
- **Reference:** ds/Overlays
- **Props / variants:** resource; reason; canRequest; breakGlass {categories, minChars:20, durationMin:60}
- **States:** denied, request sent, break-glass form, active (countdown), ended
- **Accessibility:** Explains why and who can grant. Break glass: reason + acknowledgement + PIN; persistent red banner with timer.
- **Used by:** consult (no access), network.glass, admin

## OfflineBanner / SyncIndicator / ConflictPanel
- **Reference:** ds/Overlays
- **Props / variants:** pendingCount; lastSync; conflicts[]
- **States:** online, offline, syncing, failed-retry, conflict
- **Accessibility:** role="status"; conflicts show both values and author, user picks.
- **Used by:** all apps

## Toast / InlineAlert / ConfirmDialog / Drawer / Stepper / Tabs / CommandPalette
- **Reference:** ds/Overlays
- **Props / variants:** standard
- **States:** standard
- **Accessibility:** Toasts never carry the only copy of an error; command palette ⌘K / Ctrl+K.
- **Used by:** all

## QRVerificationBlock
- **Reference:** ds/Print
- **Props / variants:** documentId; verifyUrl; shortCode (6 chars); size 18–24 mm
- **States:** final (QR shown), draft (no QR, watermark)
- **Accessibility:** Short code printed beside QR for manual entry; black ink only.
- **Used by:** print templates, patientApp.claim
