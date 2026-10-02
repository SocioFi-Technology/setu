# Sitemap — every screen, its app, module, role(s) and plan tier

Generated from `design/Setu Health.dc.html` (the index page). `plan` is the lowest tier that includes the screen (Clinic ⊂ Hospital Lite ⊂ Hospital Pro). Staff-web links open the master shell `design/Setu Staff App.dc.html` with `?role=&plan=&mod=&screen=`; the shell hides modules not in the plan and shows a "Not in your plan" / "No access" panel instead of hiding the route.

| # | App | Module | Screen | Bangla | Roles | Plan |
|---|---|---|---|---|---|---|
| 01 | Staff web | Front desk | Find patient | রোগী খোঁজা | Receptionist | Clinic |
| 02 | Staff web | Front desk | Register | নিবন্ধন | Receptionist | Clinic |
| 03 | Staff web | Front desk | Duplicate review | ডুপ্লিকেট যাচাই | Receptionist | Clinic |
| 04 | Staff web | Front desk | Appointments | অ্যাপয়েন্টমেন্ট | Receptionist | Clinic |
| 05 | Staff web | Front desk | Queue board | সিরিয়াল বোর্ড | Receptionist | Clinic |
| 06 | Staff web | Front desk | Vitals (tablet) | ভাইটাল | Nurse | Clinic |
| 07 | Staff web | OPD consultation | Consultation · draft | পরামর্শ · খসড়া | Doctor | Clinic |
| 08 | Staff web | OPD consultation | Signed note & print | স্বাক্ষরিত নোট ও প্রিন্ট | Doctor | Clinic |
| 09 | Staff web | OPD consultation | Amended note (v2) | সংশোধিত নোট | Doctor | Clinic |
| 10 | Staff web | Billing & finance | OPD bill | ওপিডি বিল | Cashier | Clinic |
| 11 | Staff web | Billing & finance | Payment (cash, card, bKash, Nagad) | পেমেন্ট | Cashier | Clinic |
| 12 | Staff web | Billing & finance | Receipt & VAT invoice | রসিদ | Cashier | Clinic |
| 13 | Staff web | Billing & finance | IPD running bill | আইপিডি বিল | Cashier | Hospital Lite |
| 14 | Staff web | Billing & finance | Package setup | প্যাকেজ | Owner, Admin | Hospital Lite |
| 15 | Staff web | Billing & finance | Refunds | রিফান্ড | Cashier, Owner | Clinic |
| 16 | Staff web | Billing & finance | Shift close | শিফট ক্লোজ | Cashier, Owner | Clinic |
| 17 | Staff web | Billing & finance | Approvals inbox | অনুমোদন | Owner, Admin | Clinic |
| 18 | Staff web | Billing & finance | Share ledger | শেয়ার লেজার | Owner, Admin | Clinic |
| 19 | Staff web | IPD & beds | Admission | ভর্তি | Receptionist | Hospital Lite |
| 20 | Staff web | IPD & beds | Bed map | বেড ম্যাপ | Nurse, Receptionist, Doctor | Hospital Lite |
| 21 | Staff web | IPD & beds | Transfer | স্থানান্তর | Nurse | Hospital Lite |
| 22 | Staff web | IPD & beds | Doctor round | রাউন্ড | Doctor | Hospital Lite |
| 23 | Staff web | IPD & beds | Discharge checklist | ছুটি | Nurse, Doctor | Hospital Lite |
| 24 | Staff web | IPD & beds | Discharge summary | ছাড়পত্র | Doctor | Hospital Lite |
| 25 | Staff web | IPD & beds | Occupancy & LOS | অকুপেন্সি | Owner | Hospital Lite |
| 26 | Staff web | Nursing | My ward | আমার ওয়ার্ড | Nurse | Hospital Lite |
| 27 | Staff web | Nursing | Vitals & MEWS | ভাইটাল ও MEWS | Nurse | Hospital Lite |
| 28 | Staff web | Nursing | Medication record (MAR) | ওষুধ (MAR) | Nurse | Hospital Lite |
| 29 | Staff web | Nursing | I/O, notes, care plan | I/O ও নোট | Nurse | Hospital Lite |
| 30 | Staff web | Nursing | Handover | হ্যান্ডওভার | Nurse | Hospital Lite |
| 31 | Staff web | Lab & diagnostics | Intake | অর্ডার গ্রহণ | Lab tech | Clinic |
| 32 | Staff web | Lab & diagnostics | Collection | নমুনা সংগ্রহ | Lab tech | Clinic |
| 33 | Staff web | Lab & diagnostics | Home collection | বাড়িতে সংগ্রহ | Lab tech | Clinic |
| 34 | Staff web | Lab & diagnostics | Accession & worklists | ওয়ার্কলিস্ট | Lab tech | Clinic |
| 35 | Staff web | Lab & diagnostics | Result entry | ফলাফল লেখা | Lab tech | Clinic |
| 36 | Staff web | Lab & diagnostics | Verification & validation | যাচাই ও অনুমোদন | Pathologist, Lab tech | Clinic |
| 37 | Staff web | Lab & diagnostics | Report (A4) | রিপোর্ট | Pathologist, Lab tech | Clinic |
| 38 | Staff web | Lab & diagnostics | Delivery | পাঠানো | Lab tech | Clinic |
| 39 | Staff web | Lab & diagnostics | QC (Levey-Jennings) | কোয়ালিটি কন্ট্রোল | Pathologist | Clinic |
| 40 | Staff web | Lab & diagnostics | Lab dashboard | ল্যাব ড্যাশবোর্ড | Pathologist, Owner | Clinic |
| 41 | Staff web | Pharmacy & inventory | Dispense | ওষুধ দেওয়া | Pharmacist | Clinic |
| 42 | Staff web | Pharmacy & inventory | OTC sale | ওটিসি বিক্রয় | Pharmacist | Clinic |
| 43 | Staff web | Pharmacy & inventory | Ward indents | ওয়ার্ড ইনডেন্ট | Pharmacist | Hospital Lite |
| 44 | Staff web | Pharmacy & inventory | Stock & expiry | মজুদ ও মেয়াদ | Pharmacist | Clinic |
| 45 | Staff web | Pharmacy & inventory | Purchase | ক্রয় | Pharmacist | Clinic |
| 46 | Staff web | Pharmacy & inventory | Count & adjust | গণনা ও সমন্বয় | Pharmacist | Clinic |
| 47 | Staff web | ER & OT | ER triage board | ট্রায়াজ | Doctor, Nurse | Hospital Lite |
| 48 | Staff web | ER & OT | Unknown patient & merge | অজ্ঞাত রোগী | Doctor | Hospital Lite |
| 49 | Staff web | ER & OT | ER orders & disposition | অর্ডার ও সিদ্ধান্ত | Doctor | Hospital Lite |
| 50 | Staff web | ER & OT | OT calendar | ওটি ক্যালেন্ডার | Doctor, Nurse | Hospital Pro |
| 51 | Staff web | ER & OT | Pre-op & WHO checklist | প্রি-অপ ও চেকলিস্ট | Doctor, Nurse | Hospital Pro |
| 52 | Staff web | ER & OT | Intra-op record | ইন্ট্রা-অপ | Doctor, Nurse | Hospital Pro |
| 53 | Staff web | Owner dashboard | Revenue, leakage, operations | আয়, লিকেজ, অপারেশন | Owner | Clinic |
| 54 | Staff web | Admin & audit | Onboarding wizard & go-live | অনবোর্ডিং | Admin | Clinic |
| 55 | Staff web | Admin & audit | Users, roles, permission matrix | ব্যবহারকারী ও ভূমিকা | Admin | Clinic |
| 56 | Staff web | Admin & audit | Masters | মাস্টার ডেটা | Admin | Clinic |
| 57 | Staff web | Admin & audit | Print template designer | প্রিন্ট টেমপ্লেট | Admin | Clinic |
| 58 | Staff web | Admin & audit | Audit log | অডিট লগ | Admin | Clinic |
| 59 | Staff web | Admin & audit | Subscription & modules | সাবস্ক্রিপশন | Admin, Owner | Clinic |
| 60 | Staff web | Admin & audit | Integrations | ইন্টিগ্রেশন | Admin | Clinic |
| 61 | Staff web | Setu network | Portable lab order | পোর্টেবল ল্যাব অর্ডার | Doctor, Lab tech | Clinic |
| 62 | Staff web | Setu network | Referral | রেফারেল | Doctor | Clinic |
| 63 | Staff web | Setu network | Shared record view & request access | শেয়ার করা রেকর্ড | Doctor | Clinic |
| 64 | Staff web | Setu network | Consent & access (patient + admin) | সম্মতি ও প্রবেশাধিকার | Admin, Owner | Clinic |
| 65 | Staff web | Setu network | Emergency access (break glass) | জরুরি প্রবেশ | Doctor | Clinic |
| 66 | Staff web | Front desk | TV token display (1920×1080) | টিভি ডিসপ্লে | Display (no login) | Clinic |
| 67 | Staff web | Shell | Home (per role) · permission denied · plan-locked · offline | হোম ও গ্লোবাল স্টেট | All staff | Clinic |
| 68 | Doctor app | Doctor app | Onboarding & chamber linking | অনবোর্ডিং | Doctor | Clinic |
| 69 | Doctor app | Doctor app | Home · today across chambers | হোম | Doctor | Clinic |
| 70 | Doctor app | Doctor app | Live queue & patient card | সিরিয়াল | Doctor | Clinic |
| 71 | Doctor app | Doctor app | Quick consult · dose grid · voice AI draft | পরামর্শ | Doctor | Clinic |
| 72 | Doctor app | Doctor app | Results inbox | রিপোর্ট ইনবক্স | Doctor | Clinic |
| 73 | Doctor app | Doctor app | Admitted patients & round notes | ভর্তি রোগী | Doctor | Clinic |
| 74 | Doctor app | Doctor app | Earnings & share statement | আয় | Doctor | Clinic |
| 75 | Patient app | Health Passport | Language, OTP, privacy | অনবোর্ডিং | Patient, Guardian | Clinic |
| 76 | Patient app | Health Passport | Claim my records (proof step) | রেকর্ড দাবি | Patient, Guardian | Clinic |
| 77 | Patient app | Health Passport | Family profiles & guardian proof | পরিবার | Patient, Guardian | Clinic |
| 78 | Patient app | Health Passport | Home | হোম | Patient, Guardian | Clinic |
| 79 | Patient app | Health Passport | Timeline with source badges | ইতিহাস | Patient, Guardian | Clinic |
| 80 | Patient app | Health Passport | Report · plain language & trend | রিপোর্ট | Patient, Guardian | Clinic |
| 81 | Patient app | Health Passport | Prescription pictograms & reminders | প্রেসক্রিপশন | Patient, Guardian | Clinic |
| 82 | Patient app | Health Passport | Share, revoke, who viewed | শেয়ার | Patient, Guardian | Clinic |
| 83 | Patient app | Health Passport | Book & pay (bKash/Nagad), receipts | অ্যাপয়েন্টমেন্ট ও পেমেন্ট | Patient, Guardian | Clinic |
| 84 | Patient app | Health Passport | Upload old papers (unverified) | পুরনো কাগজ | Patient, Guardian | Clinic |
| 85 | Patient app | Health Passport | Settings · big text · numerals · low data | সেটিং | Patient, Guardian | Clinic |
| 86 | Owner mobile | Owner dashboard | Dashboard, leakage, approvals, cash variance (412) | মালিকের ফোন | Owner | Clinic |

## Counts
- Staff web: 67 screens
- Doctor app: 7 screens
- Patient app: 11 screens
- Owner mobile: 1 screens
- Total: 86
