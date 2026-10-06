# Modular Revamp — Specification

Agreed 2026-10-06. Decisions are numbered D1–D24 so sessions and commits can cite
them. Change a decision only by editing it here with a dated note.

---

## 1. Goal

- A tenant buys **any combination of modules** (Clinic, Pharmacy, Lab, HR, …)
  and sees **only** those modules' workflows.
- Inside what the tenant bought, each **user** sees only what their permissions
  allow. Granting an extra permission reveals the extra screen, on the same page.
- A **new module is added, not woven in**: one definition, one registration,
  no edits to existing modules or workflows.
- The platform covers the whole business (clinical, pharmacy, lab, HR), so a
  clinic does not buy several products.

## 2. Where we start (facts, as of 2026-10-06)

- Three layers already exist and stay separate
  (`packages/contracts/src/onboarding.ts`, `onboarding.prisma`):
  1. `plan_features` — what the subscription **allows** (entitlement).
  2. `clinic_profile_modules` — what each **branch** runs, from that.
  3. `membership_roles` — what a **person** may do (permissions).
- `ClinicModule` enum: APPOINTMENTS, CONSULTATIONS, BILLING, INVENTORY,
  PROCUREMENT, PHARMACY, LAB, ONLINE_ORDERS. Only Pharmacy (`pharmacy_module`)
  and Lab (`lab_module`) are sold; the rest are always on.
- No organization "type" — a pharmacy and a clinic are the same tenant shape
  (ADR-0001). This stays.
- The header is 25 flat links in `clinicNav()`,
  `apps/web/src/components/tenant/tenant-header.tsx`. Module hiding is UX only;
  the API does not refuse an unbought module.
- Invoice visibility (`apps/api/src/services/invoicing/invoice-visibility.ts`):
  APPOINTMENT/PROCEDURE/SERVICE/OTHER go to every holder of
  `billing.invoice.read`, so a pharmacist sees appointment invoices today.

---

## 3. Decisions

### Product model

| #   | Decision                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **Purchasable modules are business lines:** Clinic (appointments, consultations, doctors, recall, clinical setup), Pharmacy (counter, online orders), Lab, HR. Finer add-ons (e.g. Buying) may be split out later.                         |
| D2  | **Core, for every tenant:** Patients, Invoicing, Reports, Team & access, Compliance, Organization settings, Subscription. Each shows only the parts belonging to modules the tenant owns. Advanced reports may become an add-on later.     |
| D3  | **Inventory is a shared module** that comes with any module that needs it (Pharmacy, Lab, Clinic). Never bought twice.                                                                                                                     |
| D4  | **One patient list per organization**, shared by every module. Each module sees only what its permissions allow.                                                                                                                           |
| D5  | **Team & access is core; HR is a purchasable module** (attendance, leave, holidays, benefits; payroll later).                                                                                                                              |
| D6  | **Bought per organization, switched on per branch** (current model). Per-branch pricing can come later through usage counters.                                                                                                             |
| D7  | **The API refuses an unbought module**, not only the menu. Every route checks entitlement as well as permission.                                                                                                                           |
| D8  | **Each module brings its own permission codes and default roles.** The role editor lists only bought modules' codes; a new tenant gets only its modules' default roles. Extra grants widen what a user sees.                               |
| D9  | **A module is a definition in code** (registry), not a runtime plugin. Header, Admin page, dashboard, reports, role editor, onboarding and entitlement checks all read the registry. Adding a module = one folder + one registration line. |

### Navigation and screens

| #   | Decision                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D10 | **Header = two-tier: modules + core items in the bar, the active item's screens as tabs in a sub-bar** (option A; changed 2026-10-06 from dropdowns to keep the existing design-system pattern). Built so an **app switcher** (option B) can be added later as a new header component over the same registry — see § 6.            |
| D11 | **Flatten when one module is visible and it has ≤ 4 screens.** Its screens become plain bar items (clinic-only: Appointments · Doctors · Recall). A bigger module (Pharmacy, 5) stays one item, opens active, sub-bar beneath — flattening it overflows the bar (found in Paper, 2026-10-06). Decided per user, after permissions. |
| D12 | **Doctors stays inside Clinic.** Each module keeps its own professional list (doctors; pharmacists with registration; lab signatories). A shared "Practitioners" registry may be extracted later. One person = one login with a profile per module.                                                                                |
| D13 | **A bought module's parts can be switched on per branch** (e.g. a branch with Appointments but no Consultations).                                                                                                                                                                                                                  |
| D14 | **Clinic includes Inventory, off by default per branch.** Switched on in Setup.                                                                                                                                                                                                                                                    |
| D19 | **One Reports page**, a section per module, filtered by what is bought and the user's report permissions. A module may add a shortcut to its section.                                                                                                                                                                              |
| D21 | **Compliance** = Tax + Rules. Tax always shown; Rules shown when any module dealing in regulated products is bought (Pharmacy, Lab) — declared by the module.                                                                                                                                                                      |
| D22 | **Module configuration lives in the Admin page**, in a section per module, never in the daily dropdowns.                                                                                                                                                                                                                           |
| D23 | **⚙ Admin is a page with a left sidebar** (Organization · Team & access · Compliance · Subscription · one section per module), not a nested dropdown.                                                                                                                                                                              |
| D24 | **Home is one dashboard of module tiles**, filtered by permissions. "Land on my main module" may become a per-user preference later.                                                                                                                                                                                               |

### Migration and lifecycle

| #   | Decision                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D15 | **Existing tenants lose nothing.** Every existing plan gets Clinic added; new Pharmacy-only and Lab-only plans are created without it.                                                                                                         |
| D16 | **Cancelled module:** read-only for a grace period (~90 days; history visible, nothing new created), then hidden. Data is never deleted — drug registers and GST records are legally required.                                                 |
| D17 | **Standalone Pharmacy records outside prescribers** (name + registration number typed at the counter). Standalone Lab does the same for outside referrals.                                                                                     |
| D18 | **HR has its own employee record**, optionally linked to a login — cleaners, drivers and ward assistants are employees without accounts.                                                                                                       |
| D20 | **Invoice visibility follows the module that created the invoice.** 20a: APPOINTMENT needs `appointment.read`. 20b: PROCEDURE/SERVICE need Clinic's consultation read; OTHER needs `read_all`. 20c: INVENTORY stays on `inventory.stock.read`. |

---

## 4. The visibility rule

An item is shown only when **all three** hold, and the API applies the same
three (D7):

```text
tenant bought it          (plan_features / subscription — commercial)
AND branch runs it        (clinic_profile_modules — configuration)
AND user may use it       (permissions from membership_roles — security)
```

Then: a menu whose children are all hidden is hidden; a menu with one visible
child becomes a plain link; a user with one visible module gets it flattened (D11).

---

## 5. Navigation

### 5.1 Header — tenant with every module

```text
[Logo → Home]  Patients · Clinic · Pharmacy · Lab · HR · Invoicing · Inventory · Reports        ⚙  👤
──────────────────────────────────────────────────────────────────────────────────────────────
sub-bar: the active item's screens as tabs, e.g. Pharmacy → Counter · Waiting · Dispensed · Counter sale · Deliveries
```

An item with one screen shows no sub-bar. `▾` below means "has a sub-bar", not a dropdown.

| Item        | Kind             | Children                                                  |
| ----------- | ---------------- | --------------------------------------------------------- |
| Home        | core (logo)      | Dashboard of module tiles (D24)                           |
| Patients    | core             | plain link (D4)                                           |
| Clinic ▾    | module           | Appointments · Doctors · Recall                           |
| Pharmacy ▾  | module           | Counter · Waiting · Dispensed · Counter sale · Deliveries |
| Lab ▾       | module (future)  | Orders · Samples · Results · Reports to sign              |
| HR ▾        | module (future)  | Attendance · Leave · Holidays · Benefits                  |
| Invoicing ▾ | core             | Invoices · Charges                                        |
| Inventory ▾ | shared (D3, D14) | Catalogue · Stock · Buying · Usage · Product recalls      |
| Reports     | core             | plain link (D19)                                          |
| ⚙ Admin     | core             | opens the Admin page (§ 5.2)                              |

### 5.2 Admin page (left sidebar, D22, D23)

Core groups first; below a rule, **Settings by area** (Clinic, Invoicing, Inventory, then any module). The gear shows to anyone holding at least one Admin permission; each link shows only for its own permission. Designed in Paper: page "Admin (⚙ /admin)", AD1–AD3.

| Section       | Screens                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| Organization  | Profile · Branches · Modules (what is bought, and what each branch runs)                          |
| Team & access | Staff · Roles (codes grouped by module, D8) · Invitations                                         |
| Compliance    | Tax · Rules (Places · Regulators · Rule packs · Sources)                                          |
| Subscription  | Plan and billing (rcln's plan and invoices to the clinic)                                         |
| Clinic        | Clinical terms · Consultation templates · Charts                                                  |
| Invoicing     | Prices · Charge policy (moved from the Charges page tabs)                                         |
| Inventory     | Catalogue lists (manufacturers, ingredients, compositions, categories, storage) · Usage templates |
| Lab (future)  | Test panels · Report templates                                                                    |
| HR (future)   | Leave types · Holiday calendars · Benefit plans                                                   |

### 5.3 The same rules, other tenants

| Who                                        | Header                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Clinic-only tenant                         | `Patients · Appointments · Doctors · Recall · Invoicing ▾ · Inventory ▾ · Reports · ⚙`                              |
| Pharmacy-only tenant                       | `Patients · Pharmacy · Invoicing · Inventory · Reports · ⚙` — Pharmacy active, its 5 screens in the sub-bar (D11)   |
| Default pharmacist in an enterprise tenant | Pharmacy flattened; Inventory (holds stock read); Clinic, Lab, HR hidden; invoices: Pharmacy + Inventory only (D20) |

### 5.4 Where today's 25 header links go

| Today           | New home                       | Today             | New home              |
| --------------- | ------------------------------ | ----------------- | --------------------- |
| Patients        | Header · core                  | Rules             | Admin · Compliance    |
| Appointments    | Header · Clinic                | Clinical terms    | Admin · Clinic        |
| Doctors         | Header · Clinic                | Consultations     | Admin · Clinic        |
| Recall          | Header · Clinic                | Charts            | Admin · Clinic        |
| Pharmacy        | Header · Pharmacy (its 5 tabs) | Tax               | Admin · Compliance    |
| Invoices        | Header · Invoicing             | Staff             | Admin · Team & access |
| Charges         | Header · Invoicing             | Roles             | Admin · Team & access |
| Catalogue       | Header · Inventory             | Invitations       | Admin · Team & access |
| Stock           | Header · Inventory             | Clinic (settings) | Admin · Organization  |
| Buying          | Header · Inventory             | Branches          | Admin · Organization  |
| Usage           | Header · Inventory             | Setup             | Admin · Organization  |
| Product recalls | Header · Inventory             | Billing           | Admin · Subscription  |
| Reports         | Header · core                  |                   |                       |

13 in the header, 12 in Admin. In-page tabs inside Stock, Buying, Catalogue,
Usage and Product recalls stay as tabs, except the configuration ones moved to
Admin (§ 5.2).

---

## 6. Module registry (draft shape — finalised in P2)

Each module is one definition. Everything that renders or checks a module reads
these; nothing lists modules by hand.

```ts
interface ModuleDefinition {
  key: string; // 'CLINIC' | 'PHARMACY' | 'LAB' | 'HR' | …
  label: string;
  icon: string;
  kind: 'module' | 'shared' | 'core';
  featureKey: string | null; // plan_features key; null = always available
  brings?: string[]; // shared modules it includes, e.g. ['INVENTORY'] (D3)
  parts?: { key: string; label: string; defaultOn: boolean }[]; // per-branch switches (D13, D14)
  home: string; // landing route, for a future app switcher
  routes: string[]; // route prefixes this module OWNS — exactly one owner per route
  nav: NavEntry[]; // header dropdown entries, each with permission codes
  admin: NavEntry[]; // Admin page section entries (D22)
  tiles?: TileDefinition[]; // dashboard tiles (D24)
  reports?: ReportSection[]; // Reports page section (D19)
  invoiceSources?: { source: string; permission: string }[]; // D20
  permissions: string[]; // codes it owns (D8)
  defaultRoles: RoleTemplate[]; // seeded for tenants that buy it (D8)
  regulated?: boolean; // shows Compliance → Rules (D21)
}
```

**Keeping the app switcher cheap (D10):**

- every route has exactly one owning module (or core), declared in `routes`;
- the active module is **derived from the URL**, never stored, so bookmarks and
  links land correctly;
- shared and core items are declared separately from modules, so either layout
  can place them.

---

## 7. Open items (decide in the phase named, record here)

| Item                                                                                              | Decide in |
| ------------------------------------------------------------------------------------------------- | --------- |
| Do routes get module prefixes (`/clinic/appointments`) or keep today's flat paths with a mapping? | P2        |
| Header on tablet and phone — drawer, overflow menu, or both?                                      | P1        |
| Exact grace period for a cancelled module, and who can extend it                                  | P4        |
| Default roles per module (names and codes) for Pharmacy, Lab, HR                                  | P5        |
| Plan names, prices and feature keys for Clinic-only, Pharmacy-only, Lab-only, HR add-on           | P6        |
