# Staff web app shell — roles, plans, navigation

The staff web app is ONE Next.js app with one shell (`apps/staff/app/(facility)/[facility]/layout.tsx`). Every module renders inside it; no module has its own header or nav. Prototype: `design/Setu Staff App.dc.html` (query params `role`, `plan`, `mod`, `screen`, `lang`).

## Shell parts (identical on every screen)
- **Top bar (56 px):** org + branch switcher (confirm dialog: "access changes with the branch"), role indicator ("Dr. Rahman — Consultant, Green Life Clinic"), global patient search (phone / bn or en name / patient no. / QR; F2), command palette (Ctrl/⌘+K), notifications, language toggle (বাংলা / English), numeral toggle (০১২ / 012), online / offline / syncing indicator, user menu.
- **Left nav (240 px, collapsible to 64 px icons + tooltips):** grouped, labelled; groups and items are filtered by **role** and by **plan**. Locked-by-plan items stay visible greyed with a lock icon and open a "Not in your plan" panel (owner/admin see an upgrade CTA). Items the role can't use are hidden; direct URL access renders the Permission-denied panel.
- **Patient context banner:** the same `PatientHeaderBanner` component under the top bar whenever a patient is in context (variants: opd, ipd, lab, pharmacy, billing). Allergies always visible; identity-confidence badge; payer; location/bed.
- **Global states:** offline banner + pending count, syncing, session expiring (2-min warning, re-auth keeps unsaved work), org switch confirm, Permission denied, Not in plan, 404, maintenance.

## Roles (prototype role switcher)
| key | Role | Home page shows first |
|---|---|---|
| receptionist | Receptionist | today's appointments, queue, pending payments |
| doctor | Doctor | my queue, results to review, unsigned notes |
| nurse | Nurse | my ward, due medications, MEWS alerts |
| labTech | Lab technologist | worklist by status |
| pathologist | Pathologist | to-validate, critical call-backs |
| pharmacist | Pharmacist | dispense queue, indents, near-expiry |
| cashier | Cashier | open bills, shift cash |
| owner | Owner | revenue, collections, occupancy, leakage alerts |
| admin | Admin | onboarding checklist, users pending, audit flags |

## Plans
| Plan | Modules |
|---|---|
| Clinic | Front desk, OPD consultation, Billing (OPD), Lab basic, Pharmacy basic, Reports, Network, Admin |
| Hospital Lite | + IPD & beds, Nursing, packages/deposits, Lab full |
| Hospital Pro | + ER, OT, radiology/PACS, accounts, doctor share ledger, full integrations |

Server side: `Organization.plan` + `PractitionerRole.code[]`; the nav is derived from `GET /me/capabilities` → `{ modules: [{ key, screens: [{ key, allowed: boolean, reason?: 'role'|'plan' }] }] }`. The client never decides access alone.

## Module × screen matrix (from the prototype's nav data)
| Module | Plan | Module roles | Screen | Roles | Plan | Needs patient context |
|---|---|---|---|---|---|---|
| Front desk | Clinic | Receptionist, Nurse, Admin, Owner | Find patient · রোগী খোঁজা | Receptionist, Admin, Owner | Clinic |  |
| Front desk | Clinic | Receptionist, Nurse, Admin, Owner | Register · নিবন্ধন | Receptionist, Admin | Clinic |  |
| Front desk | Clinic | Receptionist, Nurse, Admin, Owner | Duplicate review · ডুপ্লিকেট যাচাই | Receptionist, Admin | Clinic |  |
| Front desk | Clinic | Receptionist, Nurse, Admin, Owner | Appointments · অ্যাপয়েন্টমেন্ট | Receptionist, Admin, Owner | Clinic |  |
| Front desk | Clinic | Receptionist, Nurse, Admin, Owner | Queue board · সিরিয়াল বোর্ড | Receptionist, Admin, Owner | Clinic |  |
| Front desk | Clinic | Receptionist, Nurse, Admin, Owner | Vitals (nurse) · ভাইটাল | Nurse, Receptionist | Clinic | yes |
| OPD consultation | Clinic | Doctor | Consultation · draft · আজকের রোগী · খসড়া | Doctor | Clinic | yes |
| OPD consultation | Clinic | Doctor | Signed note · স্বাক্ষরিত নোট | Doctor | Clinic | yes |
| OPD consultation | Clinic | Doctor | Amended note · সংশোধিত নোট | Doctor | Clinic | yes |
| Billing & finance | Clinic | Cashier, Owner, Admin, Receptionist | OPD bill · ওপিডি বিল | Cashier, Owner, Admin, Receptionist | Clinic | yes |
| Billing & finance | Clinic | Cashier, Owner, Admin, Receptionist | Payment · পেমেন্ট | Cashier, Owner, Admin | Clinic | yes |
| Billing & finance | Clinic | Cashier, Owner, Admin, Receptionist | Receipt · রসিদ | Cashier, Owner, Admin | Clinic | yes |
| Billing & finance | Clinic | Cashier, Owner, Admin, Receptionist | IPD running bill · আইপিডি বিল | Cashier, Owner, Admin | Hospital Lite | yes |
| Billing & finance | Clinic | Cashier, Owner, Admin, Receptionist | Packages · প্যাকেজ | Owner, Admin | Hospital Lite |  |
| Billing & finance | Clinic | Cashier, Owner, Admin, Receptionist | Refunds · রিফান্ড | Cashier, Owner, Admin | Clinic |  |
| Billing & finance | Clinic | Cashier, Owner, Admin, Receptionist | Shift close · শিফট ক্লোজ | Cashier, Owner, Admin | Clinic |  |
| Billing & finance | Clinic | Cashier, Owner, Admin, Receptionist | Approvals · অনুমোদন | Owner, Admin | Clinic |  |
| Billing & finance | Clinic | Cashier, Owner, Admin, Receptionist | Share ledger · শেয়ার লেজার | Owner, Admin | Clinic |  |
| IPD & beds | Hospital Lite | Receptionist, Doctor, Nurse, Owner, Admin | Admission · ভর্তি | Receptionist, Admin | Hospital Lite |  |
| IPD & beds | Hospital Lite | Receptionist, Doctor, Nurse, Owner, Admin | Bed map · বেড ম্যাপ | Receptionist, Doctor, Nurse, Owner, Admin | Hospital Lite |  |
| IPD & beds | Hospital Lite | Receptionist, Doctor, Nurse, Owner, Admin | Transfer · স্থানান্তর | Nurse, Receptionist, Admin | Hospital Lite | yes |
| IPD & beds | Hospital Lite | Receptionist, Doctor, Nurse, Owner, Admin | Doctor round · রাউন্ড | Doctor, Admin | Hospital Lite |  |
| IPD & beds | Hospital Lite | Receptionist, Doctor, Nurse, Owner, Admin | Discharge · ছুটি | Nurse, Doctor, Receptionist, Admin | Hospital Lite | yes |
| IPD & beds | Hospital Lite | Receptionist, Doctor, Nurse, Owner, Admin | Discharge summary · ছাড়পত্র | Doctor, Admin | Hospital Lite | yes |
| IPD & beds | Hospital Lite | Receptionist, Doctor, Nurse, Owner, Admin | Occupancy & LOS · অকুপেন্সি | Owner, Admin | Hospital Lite |  |
| Nursing | Hospital Lite | Nurse, Admin | My ward · আমার ওয়ার্ড | Nurse, Admin | Hospital Lite |  |
| Nursing | Hospital Lite | Nurse, Admin | Vitals & MEWS · ভাইটাল ও MEWS | Nurse, Admin | Hospital Lite | yes |
| Nursing | Hospital Lite | Nurse, Admin | Medication (MAR) · ওষুধ (MAR) | Nurse, Admin | Hospital Lite | yes |
| Nursing | Hospital Lite | Nurse, Admin | I/O, notes, care plan · I/O ও নোট | Nurse, Admin | Hospital Lite | yes |
| Nursing | Hospital Lite | Nurse, Admin | Handover · হ্যান্ডওভার | Nurse, Admin | Hospital Lite |  |
| Lab & diagnostics | Clinic | Lab technologist, Pathologist, Admin, Owner | Intake · অর্ডার গ্রহণ | Lab technologist, Admin | Clinic |  |
| Lab & diagnostics | Clinic | Lab technologist, Pathologist, Admin, Owner | Collection · নমুনা সংগ্রহ | Lab technologist, Admin | Clinic |  |
| Lab & diagnostics | Clinic | Lab technologist, Pathologist, Admin, Owner | Home collection · বাড়িতে সংগ্রহ | Lab technologist, Admin | Clinic |  |
| Lab & diagnostics | Clinic | Lab technologist, Pathologist, Admin, Owner | Accession & worklists · ওয়ার্কলিস্ট | Lab technologist, Admin | Clinic |  |
| Lab & diagnostics | Clinic | Lab technologist, Pathologist, Admin, Owner | Result entry · ফলাফল লেখা | Lab technologist, Admin | Clinic | yes |
| Lab & diagnostics | Clinic | Lab technologist, Pathologist, Admin, Owner | Verification · যাচাই ও অনুমোদন | Pathologist, Lab technologist, Admin | Clinic | yes |
| Lab & diagnostics | Clinic | Lab technologist, Pathologist, Admin, Owner | Report · রিপোর্ট | Pathologist, Lab technologist, Admin | Clinic |  |
| Lab & diagnostics | Clinic | Lab technologist, Pathologist, Admin, Owner | Delivery · পাঠানো | Lab technologist, Admin | Clinic |  |
| Lab & diagnostics | Clinic | Lab technologist, Pathologist, Admin, Owner | QC · কোয়ালিটি কন্ট্রোল | Pathologist, Admin | Clinic |  |
| Lab & diagnostics | Clinic | Lab technologist, Pathologist, Admin, Owner | Lab dashboard · ল্যাব ড্যাশবোর্ড | Pathologist, Owner, Admin | Clinic |  |
| Pharmacy & inventory | Clinic | Pharmacist, Admin, Owner | Dispense · ওষুধ দেওয়া | Pharmacist, Admin, Owner | Clinic | yes |
| Pharmacy & inventory | Clinic | Pharmacist, Admin, Owner | OTC sale · ওটিসি বিক্রয় | Pharmacist, Admin, Owner | Clinic |  |
| Pharmacy & inventory | Clinic | Pharmacist, Admin, Owner | Ward indents · ওয়ার্ড ইনডেন্ট | Pharmacist, Admin, Owner | Hospital Lite |  |
| Pharmacy & inventory | Clinic | Pharmacist, Admin, Owner | Stock & expiry · মজুদ ও মেয়াদ | Pharmacist, Admin, Owner | Clinic |  |
| Pharmacy & inventory | Clinic | Pharmacist, Admin, Owner | Purchase · ক্রয় | Pharmacist, Admin, Owner | Clinic |  |
| Pharmacy & inventory | Clinic | Pharmacist, Admin, Owner | Count & adjust · গণনা ও সমন্বয় | Pharmacist, Admin, Owner | Clinic |  |
| ER & OT | Hospital Lite | Doctor, Nurse, Admin | ER triage · ট্রায়াজ | Doctor, Nurse, Admin | Hospital Lite |  |
| ER & OT | Hospital Lite | Doctor, Nurse, Admin | Unknown & merge · অজ্ঞাত রোগী | Doctor, Nurse, Admin | Hospital Lite |  |
| ER & OT | Hospital Lite | Doctor, Nurse, Admin | ER orders & disposition · অর্ডার ও সিদ্ধান্ত | Doctor, Nurse, Admin | Hospital Lite | yes |
| ER & OT | Hospital Lite | Doctor, Nurse, Admin | OT calendar · ওটি ক্যালেন্ডার | Doctor, Nurse, Admin | Hospital Pro |  |
| ER & OT | Hospital Lite | Doctor, Nurse, Admin | Pre-op & WHO checklist · প্রি-অপ ও চেকলিস্ট | Doctor, Nurse, Admin | Hospital Pro | yes |
| ER & OT | Hospital Lite | Doctor, Nurse, Admin | Intra-op record · ইন্ট্রা-অপ | Doctor, Nurse, Admin | Hospital Pro | yes |
| Owner dashboard | Clinic | Owner, Admin | Revenue, leakage, operations · আয়, লিকেজ, অপারেশন | Owner, Admin | Clinic |  |
| Admin & audit | Clinic | Admin, Owner | Onboarding · অনবোর্ডিং | Admin, Owner | Clinic |  |
| Admin & audit | Clinic | Admin, Owner | Users & roles · ব্যবহারকারী ও ভূমিকা | Admin, Owner | Clinic |  |
| Admin & audit | Clinic | Admin, Owner | Masters · মাস্টার ডেটা | Admin, Owner | Clinic |  |
| Admin & audit | Clinic | Admin, Owner | Print templates · প্রিন্ট টেমপ্লেট | Admin, Owner | Clinic |  |
| Admin & audit | Clinic | Admin, Owner | Audit log · অডিট লগ | Admin, Owner | Clinic |  |
| Admin & audit | Clinic | Admin, Owner | Subscription · সাবস্ক্রিপশন | Admin, Owner | Clinic |  |
| Admin & audit | Clinic | Admin, Owner | Integrations · ইন্টিগ্রেশন | Admin, Owner | Clinic |  |
| Setu network | Clinic | Doctor, Admin, Owner, Lab technologist, Receptionist | Portable lab order · পোর্টেবল ল্যাব অর্ডার | Doctor, Admin, Owner, Lab technologist, Receptionist | Clinic |  |
| Setu network | Clinic | Doctor, Admin, Owner, Lab technologist, Receptionist | Referral · রেফারেল | Doctor, Admin, Owner, Lab technologist, Receptionist | Clinic |  |
| Setu network | Clinic | Doctor, Admin, Owner, Lab technologist, Receptionist | Shared record view · শেয়ার করা রেকর্ড | Doctor, Admin | Clinic |  |
| Setu network | Clinic | Doctor, Admin, Owner, Lab technologist, Receptionist | Consent & access · সম্মতি ও প্রবেশাধিকার | Admin, Owner, Doctor | Clinic |  |
| Setu network | Clinic | Doctor, Admin, Owner, Lab technologist, Receptionist | Emergency access · জরুরি প্রবেশ | Doctor, Admin | Clinic |  |

## Route → shell mapping
Routes in `screens.md` are unchanged; the shell is the `layout.tsx` above them. Legacy per-module prototype pages (`design/Setu Front Desk.dc.html` etc.) remain as detailed references for each screen's states; the master `Setu Staff App.dc.html` embeds them with `embedded=true`, which removes their review bars and lets the shell own header, nav and patient banner.

## Journeys through the shell
`design/Setu Journeys.dc.html` runs journeys A–E inside the master shell: each step sets role, plan, module and screen, and is labelled with step id, role and device. Use it as the acceptance script for end-to-end tests (see `screens.md` transitions for the expected state after each step).
