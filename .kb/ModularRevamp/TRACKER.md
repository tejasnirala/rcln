# Modular Revamp — Tracker

Tick items as they finish; never tick one that was only written and not
checked. Decision numbers (Dn) refer to [SPEC.md](SPEC.md).

## Phases

| Phase | What                                                                          | Status        |
| ----- | ----------------------------------------------------------------------------- | ------------- |
| P0    | Requirements agreed                                                           | ✅ 2026-10-06 |
| P1    | Paper design — every frame below, signed off                                  | ⏳ next       |
| P2    | Module registry + header + Admin page + dashboard (web)                       | ☐             |
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

### 1b — New screens (add masters to DS 07 first)

- [x] AD4 Admin → Organization → Modules: branch tabs, running / shared Inventory / on-plan-off-here cards (D3, D6, D13, D14)
- [x] AD5 Admin → Team & access → Roles: roles grouped by the module that brings them; permissions grouped by module (D8). Role-to-module assignment is a draft until P5
- [ ] Admin → Compliance → Tax and Rules (D21)
- [ ] Admin → a settings-by-area page, e.g. Clinic → Clinical terms (D22)
- [ ] Home dashboard, enterprise owner and pharmacist variants (D24)
- [ ] Reports page with module sections (D19)
- [ ] Cancelled module, read-only state with grace banner (D16)
- [ ] App switcher concept frame — only to prove the registry shape supports it (D10)
- [ ] Sign-off recorded in the session log

### Master usage map (Design system → DS 07)

| Master                          | Used on                                               |
| ------------------------------- | ----------------------------------------------------- |
| H1 All modules · Pharmacy       | DS 05 App header                                      |
| H2 Clinic only                  | —                                                     |
| H3 Pharmacy only                | —                                                     |
| H4 Single-screen (Patients)     | LD1, LD2                                              |
| H5 Admin active                 | AD1, AD2, AD4, AD5; PR1–PR4, MR1–MR4, X1, X2          |
| H6 Nothing active               | PF1, PF2, PX2, PX3; ST1, ST3; 404 (N2, RX2), 500 (E2) |
| H7 Clinic active · Appointments | LD3, DS 05b (search as icon), DS 05c                  |
| A1 Admin sidebar · Owner        | AD1, AD3 (phone list), AD4, AD5                       |
| A2 Admin sidebar · Fewer perms  | AD2                                                   |
| Module card (4 states)          | O3 desktop, tablet, phone; AD4                        |
| Permission group                | AD5                                                   |

## P2 onwards

Checklists are written at the start of each phase, from the signed-off frames.

## Session log

| Date       | Session summary                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-06 | Requirements grilled and agreed (D1–D24). Branch `feat/module-revamp` and these docs created.                                                                             |
| 2026-10-06 | P1 started. D10 → two-tier header (kept the design-system pattern); D11 refined to ≤ 4 screens. DS 07 masters H1–H5 built; DS 05 updated.                                 |
| 2026-10-06 | 1a complete: H6/H7 masters, header swapped on 24 screens, Admin page AD1–AD3 + sidebar masters, module card + O3 rebuilt, sign-up copy → organisation, Pharmacy org type. |
| 2026-10-06 | 1b started: AD4 Modules (shared Inventory card added as a module-card state), AD5 Roles, permission-group master.                                                         |
