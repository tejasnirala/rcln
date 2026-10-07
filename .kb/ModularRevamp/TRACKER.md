# Modular Revamp — Tracker

Tick items as they finish; never tick one that was only written and not
checked. Decision numbers (Dn) refer to [SPEC.md](SPEC.md).

## Phases

| Phase | What                                                                          | Status        |
| ----- | ----------------------------------------------------------------------------- | ------------- |
| P0    | Requirements agreed                                                           | ✅ 2026-10-06 |
| P1    | Paper design — every frame below, signed off                                  | ✅ 2026-10-07 |
| P2    | Module registry + header + Admin page + dashboard (web)                       | ⏳ next       |
| P3    | Reports page by module                                                        | ☐             |
| P4    | API entitlement checks + cancelled-module read-only                           | ☐             |
| P5    | Module-aware permissions and default roles                                    | ☐             |
| P6    | Clinic as a product; plan data migration                                      | ☐             |
| P7    | Invoice visibility per module                                                 | ☐             |
| P8    | Move module config into Admin (prices, policy, catalogue lists)               | ☐             |
| Later | Outside prescribers (D17) · Lab module · HR module (D18) · app switcher (D10) | ☐             |

## P1 — Paper design

Paper file **rcln**. Order: update existing designs first (1a), then new screens (1b).
Modularity rule: every screen copies its header/shell from the masters on
**Design system → DS 07 · Components**; change the master first, then the
screens in the usage map below. (Paper tools cannot make linked components.)

### 1a — Update existing designs ✅ (2026-10-06)

- [x] DS 07 · Components: header masters H1–H7, Admin sidebar A1/A2, module card
- [x] DS 05 · Navigation & layout: header, page map, phone bar + menu sheet, breakpoint rule (search is an icon below 1280)
- [x] Old header replaced on all 24 screens (usage map below)
- [x] DS 05a/b/c samples: Clinic sub-bar; tablet bar fits at 1024
- [x] Payment result: breadcrumb and links → Admin › Plan and billing
- [x] Onboarding O3 "What you run" → module cards with per-branch parts (D1, D13, D14) — desktop, tablet, phone; O7 summary updated
- [x] Sign-up and login copy: "clinic" → "organisation"; "Pharmacy" added to organisation type (D1)
- [x] My profile: "Billing" → "Invoicing". Role matrix unchanged — default roles per module are decided in P5
- [x] Admin page (pulled forward from 1b): AD1 owner, AD2 fewer permissions, AD3 phone — page "Admin (⚙ /admin)"

### 1b — New screens (add masters to DS 07 first) ✅ (2026-10-07)

- [x] AD4 Admin → Organization → Modules: branch tabs, running / shared Inventory / on-plan-off-here cards (D3, D6, D13, D14)
- [x] AD5 Admin → Team & access → Roles: roles grouped by the module that brings them; permissions grouped by module (D8). Role-to-module assignment is a draft until P5
- [x] AD6 Admin → Compliance → Tax and AD7 Rules: one jurisdiction block per country/region (D21)
- [x] AD8 Admin → Clinic → Clinical terms (settings by area, D22)
- [x] HM1 owner / HM2 pharmacist Home — page "Home (dashboard)" (D24)
- [x] RP1 Reports with a row per module + "Across modules" — page "Reports (/reports)" (D19)
- [x] ML1 Pharmacy cancelled, read-only banner, create locked — page "Module lifecycle" (D16)
- [x] App switcher concept on DS 07, marked not for build (D10)
- [x] DS 08 · Record history: the history sheet as a design-system pattern (in context, entry kinds, states, triggers, phone), drawn from `record-history.tsx` and the `audit.ts` contract
- [x] DS 09 · Find, filter and sort: 4 search bars, single and multi autosearch, filter controls by value count + phone sheet + empty state, column sort (asc/desc), pagination. Built on `paginationQuery` (page, limit ≤ 100, sortBy, sortOrder)
- [x] Every Admin option, one screen per existing tab (AD9–AD35): org, team, compliance, plan, Clinic / Invoicing / Inventory settings, all 7 clinical-term kinds, 5 catalogue tabs, template / chart / usage editors
- [x] Home per role (HM3–HM7): owner with charts, doctor day timeline, receptionist, accountant, pharmacist with one extra report permission
- [x] Reports (RP1 catalogue redone with the 9 real reports; RP2–RP10 one detailed screen each, columns from `packages/contracts/src/reports.ts`)
- [x] Lifecycle (ML2–ML8): pharmacy-only ended (owner, pharmacist), payment failed / grace, 30-day and 7-day renewal banners, module trial ending, AutoPay mandate dialog
- [x] Tablet 1024 + phone 390 pattern screens, a few per area (each carries a dashed "design note" naming the rule and the screens it covers): Admin TA1–TA3 / PA1–PA3, Home TH1–TH2 / PH1–PH2, Reports TR1–TR2 / PR1–PR3, Lifecycle TL1 / PL1–PL2. AD3 phone list now has the full sidebar
- [x] Core and Clinic screens, own layouts on the existing fields (pages "Clinic › Appointments", "Clinic › Doctors", "Clinic › Recall", "Patients", "Invoicing › Invoices"): AP1 day board, AP2 booking sheet, AP2b patient-step states, AP4 visit; DR1 roster, DR2 add a doctor, DR3 profile; RC1 recall; PT1 find, PT2 register sheet, PT3 record, PT4 visit history; IN1 list, IN2 invoice. `/branches` stays AD10 on the Admin page
- [x] Route screens, tablet 1024 + phone 390 (one per pattern, a dashed design note per page): AP1-T, AP1-P, AP2-P, AP4-T, AP4-P; DR1-T, DR1-P, DR2-P; RC1-P, RC1-P2 (shared ⋯ bottom sheet); PT1-P, PT3-T, PT3-P; IN1-P, IN2-T, IN2-P
- [x] Consultation page (Paper, not a route): AP4 visit frames moved there as CN0/-T/-P; CN1 Teeth, CN2 Body, CN3 Skeleton, CN4 Scalp on realistic imagery; CN5 the Lens (selection motion); CN6 access. Spec: [CONSULTATION_CHARTS.md](CONSULTATION_CHARTS.md)
- [x] Sign-off recorded in the session log (2026-10-07)

### Master usage map (Design system → DS 07)

| Master                          | Used on                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| H1 All modules · Pharmacy       | DS 05 App header; ML1; app-switcher concept                                               |
| H2 Clinic only                  | —                                                                                         |
| H3 Pharmacy only                | —                                                                                         |
| H4 Single-screen (Patients)     | LD1, LD2; RP1 (pill moved to Reports)                                                     |
| H5 Admin active                 | AD1, AD2, AD4–AD8; PR1–PR4, MR1–MR4, X1, X2                                               |
| H6 Nothing active               | PF1, PF2, PX2, PX3; ST1, ST3; 404 (N2, RX2), 500 (E2); HM1, HM2 (no Clinic item, no gear) |
| H7 Clinic active · Appointments | LD3, DS 05b (search as icon), DS 05c                                                      |
| A1 Admin sidebar · Owner        | AD0 and every AD screen except AD2; AD3 (phone list)                                      |
| A2 Admin sidebar · Fewer perms  | AD2                                                                                       |
| Module card (4 states)          | O3 desktop, tablet, phone; AD4                                                            |
| Permission group                | AD5                                                                                       |
| Jurisdiction block              | AD6, AD7, AD8 (as term list)                                                              |
| Dashboard tile group            | HM1, HM2                                                                                  |
| Overview row (Admin home)       | AD1, AD2, RP1                                                                             |
| DS 08 History sheet             | every record's History link or button (`RecordHistory`, `HistoryDialog`)                  |
| DS 09 Find, filter, sort        | every list: Patients, Doctors, Appointments, Recall, Invoices, Charges, Inventory         |
| Read-only module banner         | ML1, ML2, ML3 (danger), ML4 (warning), ML6 (info)                                         |
| AD0 Admin shell                 | AD9–AD35 (sidebar from A1; set the active item)                                           |
| App banner (30 d / 7 d)         | ML5, ML7                                                                                  |

## P2 onwards

Checklists are written at the start of each phase, from the signed-off frames.

## Session log

| Date       | Session summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-06 | Requirements grilled and agreed (D1–D24). Branch `feat/module-revamp` and these docs created.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-10-06 | P1 started. D10 → two-tier header (kept the design-system pattern); D11 refined to ≤ 4 screens. DS 07 masters H1–H5 built; DS 05 updated.                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-10-06 | 1a complete: H6/H7 masters, header swapped on 24 screens, Admin page AD1–AD3 + sidebar masters, module card + O3 rebuilt, sign-up copy → organisation, Pharmacy org type.                                                                                                                                                                                                                                                                                                                                                       |
| 2026-10-06 | 1b started: AD4 Modules (shared Inventory card added as a module-card state), AD5 Roles, permission-group master.                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-10-06 | Every Admin option drawn (AD9–AD35, from the AD0 shell master): Profile, Branches, Staff, Invitations, Job titles, Plan, Rules tabs + pack, Appointment settings, Fees, Clinical terms (all 7 kinds), Consultation templates + editor, Charts + editor, Invoicing settings, Prices, Charge policy, Inventory settings, 5 catalogue tabs, Usage templates + editor. Still to do: swap old sidebars on AD1/AD4–AD8; per-role dashboards + doctor timeline; 9 detailed reports; expired pharmacy-only + 30/7-day renewal warnings. |
| 2026-10-06 | 1b screens complete: AD6 Tax, AD7 Rules, AD8 Clinical terms, HM1/HM2 Home, RP1 Reports, ML1 read-only module, app-switcher concept; masters added for jurisdiction block, tile group, read-only banner. Awaiting sign-off.                                                                                                                                                                                                                                                                                                      |
| 2026-10-06 | Rest of 1b. Every Admin screen drawn and old sidebars replaced; Home for 5 roles; RP1 shows the 9 real reports plus a detail screen for each; lifecycle ML2–ML8. Two open items added to SPEC §7. Awaiting sign-off.                                                                                                                                                                                                                                                                                                            |
| 2026-10-06 | Responsive patterns: 8 tablet + 10 phone screens (not every screen, one per pattern); AD3 sidebar refreshed. Awaiting sign-off.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-10-06 | DS 08 · Record history added to the Design system page: right-hand sheet, day-grouped timeline, was → now diffs, rcln-staff chip, 4 states, triggers, phone. Same API fields; client-side filter tabs are the only addition.                                                                                                                                                                                                                                                                                                    |
| 2026-10-06 | Route screens for /appointments, /doctors, /recall, /patients, /invoices (14 desktop frames, one Paper page per route under its header group). New layouts; fields, labels and actions taken from the components. Not drawn: week/month board view, tablet/phone. Awaiting sign-off.                                                                                                                                                                                                                                            |
| 2026-10-06 | Responsive frames for the route screens: 16 tablet/phone frames + 5 design notes. Phone long forms (Add a doctor) become steps; row overflow is one ⋯ bottom sheet. Awaiting sign-off.                                                                                                                                                                                                                                                                                                                                          |
| 2026-10-06 | DS 09 · Find, filter and sort added to the Design system page. Sorting and pagination follow `paginationQuery`/`Paginated` in contracts; status labels from `INVOICE_STATUS_LABELS`.                                                                                                                                                                                                                                                                                                                                            |
| 2026-10-06 | Consultation page: detailed regions for 4 charts (spec in CONSULTATION_CHARTS.md), realistic generated anatomy with region overlays, the Lens motion, access states. Needs `lod` in region grammar, `visual_maps.qualifiers`, new `HUMAN_SKELETON` map. Awaiting sign-off.                                                                                                                                                                                                                                                      |
| 2026-10-06 | Consultation: image charts become reference-only. Teeth stay tap-to-select; body/skeleton/scalp show numbered markers and add entries through one data-driven **Add finding** picker (CN7: search, region drill-down, Left/Right, multi-select). Lens updated for markers. "Mark exact spot" recorded as future. Awaiting sign-off.                                                                                                                                                                                             |
| 2026-10-06 | Consultation layout settled: one vertical page with a pinned section strip (no tabs). CN8 doctor consulting, CN8b signed read-only, desktop. Awaiting sign-off.                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-10-07 | **P1 signed off** by the user: 1a (existing designs updated) and 1b (new screens) accepted as drawn. P2 is next.                                                                                                                                                                                                                                                                                                                                                                                                                |
