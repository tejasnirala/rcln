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

Design in Paper before any code. Each frame cites the spec section it shows.

- [ ] Header, all modules, closed (§ 5.1)
- [ ] Header, all modules, with Clinic ▾, Inventory ▾ and Invoicing ▾ open (§ 5.1)
- [ ] Header, clinic-only tenant, flattened (§ 5.3, D11)
- [ ] Header, pharmacy-only tenant, flattened (§ 5.3, D11)
- [ ] Header, default pharmacist in an enterprise tenant (§ 5.3)
- [ ] Header on tablet and phone (§ 7 open item)
- [ ] Admin page shell with sidebar, Organization selected (§ 5.2, D23)
- [ ] Admin → Team & access → Roles, permission codes grouped by module (D8)
- [ ] Admin → Compliance → Tax and Rules (D21)
- [ ] Admin → a module section, e.g. Clinic setup (D22)
- [ ] Admin → Setup, modules per branch: bought vs not bought, parts on/off (D6, D13, D14)
- [ ] Home dashboard, enterprise owner and pharmacist variants (D24)
- [ ] Reports page with module sections (D19)
- [ ] Cancelled module, read-only state with grace banner (D16)
- [ ] App switcher concept frame — only to prove the registry shape supports it (D10)
- [ ] Sign-off recorded in the session log

## P2 onwards

Checklists are written at the start of each phase, from the signed-off frames.

## Session log

| Date       | Session summary                                                                               |
| ---------- | --------------------------------------------------------------------------------------------- |
| 2026-10-06 | Requirements grilled and agreed (D1–D24). Branch `feat/module-revamp` and these docs created. |
