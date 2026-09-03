import type { AuthSession } from '@rcln/contracts';
/*
 * ⚠️ THE CONSTANTS, NOT STRING LITERALS. All twenty-four nav entries used to
 *   spell their permission codes by hand, so a rename in `@rcln/permissions`
 *   would silently hide a tab with no build error — the navigation would just
 *   quietly lose a section for everybody. (PI-24 review.)
 */
import { PERMISSIONS as P } from '@rcln/permissions';
import { signOut } from '@/app/(tenant)/t/[slug]/actions';
import { AppHeader } from '@/components/shell/app-header';
import type { NavLink } from '@/components/shell/app-nav';
import { ScopeLabel } from '@/components/shell/scope-switcher';
import { SignOutButton } from '@/components/shell/sign-out-button';
import { BranchSwitcher } from './branch-switcher';

/**
 * The clinic's shell — `AppHeader` filled in with this clinic's scopes and nav.
 *
 * There is one header in the application now (components/shell/app-header.tsx);
 * this decides what goes in it for someone standing inside a clinic. A super
 * admin who has walked in gets the same thing, with the dark `PlatformStrip`
 * above it.
 *
 * A SERVER COMPONENT. Only the branch switcher and the sign-out button need to be
 * client components, and they are. This whole file used to be `'use client'`
 * because of the one dropdown, which shipped the nav and every label to the
 * browser for no reason.
 */
export function TenantHeader({ slug, session }: { slug: string; session: AuthSession }) {
  const membership = session.memberships.find(
    (m) => m.organizationId === session.activeOrganizationId
  );
  const branches = membership?.branches ?? [];

  /*
   * THE SCOPE CHAIN
   *   The clinic first, then the branch inside it. The clinic segment is a plain
   *   label here because this session belongs to one clinic — a super admin's
   *   session does not, and their layout passes a switcher in this position
   *   instead. Same chain, one more degree of freedom.
   *
   *   Under impersonation `memberships` is the admin's own and is almost always
   *   empty, so there are no branches to switch between and the strip above names
   *   the clinic. The segment is dropped rather than rendered empty.
   */
  const scopes = [
    <ScopeLabel key="clinic" label="Clinic" name={slug} />,
    ...(branches.length > 0
      ? [
          <BranchSwitcher
            key="branch"
            slug={slug}
            branches={branches}
            activeBranchId={session.activeBranchId}
          />,
        ]
      : []),
  ];

  return (
    <AppHeader
      scopes={scopes}
      user={{
        name: session.user.fullName,
        href: '/verify',
        /*
         * Offered to anyone who may read a doctor profile. For a doctor it is
         * the only way to their own — the Doctors tab is the roster and they do
         * not hold `doctor.directory.read`. For an admin who is not a
         * practitioner the page says so in a sentence, which is cheaper than
         * asking the API here whether they have a profile just to decide
         * whether to render a link.
         */
        ...(session.permissions.includes('doctor.read')
          ? { ownProfile: { href: '/profile', label: 'My profile' } }
          : {}),
      }}
      signOut={
        // Bound server-side, like every other action here, so the browser cannot
        // substitute another clinic's slug. The navigation is ours rather than the
        // action's: `/login` is this clinic's sign-in page only after the proxy
        // rewrite, and the apex serves a clinic finder at the same path.
        <SignOutButton action={signOut.bind(null, slug)} redirectTo="/login" />
      }
      nav={{ label: 'Clinic', links: clinicNav(session.permissions) }}
    />
  );
}

/**
 * Where you can go from inside a clinic.
 *
 * Each destination names the permission that makes it usable, and a link the
 * caller cannot use is not rendered — following it would only produce a 403 at the
 * API. This grows as later phases land; it is not a placeholder.
 *
 * Permissions are resolved fresh per request by the API, never read from the JWT,
 * so this reflects a role change on the next page load. A platform admin comes
 * back holding the whole catalogue, which is why they see every entry.
 */
function clinicNav(permissions: string[]): NavLink[] {
  return [
    { href: '/branches', label: 'Branches', permission: [P.BRANCH_READ] },
    // Sits next to Branches rather than under Staff: a doctor's working hours
    // are what the front desk books against, so this is a scheduling screen that
    // happens to be about people, not a personnel one.
    //
    // ⚠️ `doctor.directory.read`, NOT `doctor.read`, AND THAT IS WHAT MAKES A
    //   DOCTOR'S NAVIGATION TWO TABS. This screen is the roster; a doctor holds
    //   `doctor.read` for their OWN profile and does not hold this, so the tab
    //   is not offered to them and `GET /doctors` would refuse it anyway. The
    //   nav and the API are reading the same code, which is the only way the two
    //   cannot drift — and no role is named anywhere (ADR-0002).
    { href: '/doctors', label: 'Doctors', permission: [P.DOCTOR_DIRECTORY_READ] },
    // First in the list that is about the people being treated rather than the
    // people doing the treating, and the only destination behind it that
    // discloses PHI. Every screen under it writes a `data_access_logs` row.
    { href: '/patients', label: 'Patients', permission: [P.PATIENT_READ] },
    // Sits after Patients because it is about them, and before Staff because it
    // is the screen the front desk actually works from all day.
    { href: '/appointments', label: 'Appointments', permission: [P.APPOINTMENT_READ] },
    /*
     * ⚠️ `appointment.read`, THE SAME CODE AS THE BOARD, AND NOT A CLINICAL ONE
     *   (CE-5). The recall list is worked by the front desk: somebody rings the
     *   patient and books them in. The desk holds no clinical code at all, so
     *   gating this behind `clinical.encounter.read` would offer the tab only to
     *   the people who do not do the job. Advising a follow-up IS clinical and
     *   happens in the consultation — invariant 7, applied to a chase rather
     *   than to a chart.
     *
     * Sits directly after Appointments because it is the same desk's second
     * screen: the board is today, and this is who should have been on it.
     */
    { href: '/recall', label: 'Recall', permission: [P.APPOINTMENT_READ] },
    /*
     * ⚠️ "INVOICES", NOT "BILLING" — THE TAB BELOW IS ALREADY CALLED BILLING AND
     *   IS A DIFFERENT DOCUMENT ENTIRELY. That one is rcln billing the CLINIC
     *   for its subscription; this one is the clinic billing a PATIENT. Two
     *   tables, two lifecycles, two permission families (`organization.billing.*`
     *   against `billing.invoice.*`), and a clinic administrator holds both. A
     *   second tab reading "Billing" would be the §0.1 confusion rendered as
     *   navigation.
     *
     * Sits beside Appointments because that is where most of its rows come from.
     */
    { href: '/invoices', label: 'Invoices', permission: [P.INVOICE_READ] },
    /*
     * ⚠️ "CHARGES", AND IT IS A SEPARATE TAB FROM INVOICES ON PURPOSE (PI-8).
     *   An invoice is a document that exists; this is everything that has been
     *   handed over and has NOT reached one. They are different questions asked
     *   by the same person at different moments — the till raises bills all day
     *   and checks the charge queue when the day's takings do not add up — and
     *   one tab holding both would bury the outstanding list inside the ledger.
     *
     * ⚠️ AND IT IS NOT UNDER PHARMACY, even though pharmacy is its only writer
     *   today. PI-ADR-005 makes the charge seam shared: PI-9's clinical
     *   consumption writes the same queue from the other side, and a receptionist
     *   should not need a pharmacy permission to see what a procedure consumed.
     *
     * Sits directly after Invoices because it is where most future invoice lines
     * come from. Gated on `billing.charge_request.read`, which a pharmacist holds
     * for visibility and the front desk holds to work.
     */
    { href: '/charges', label: 'Charges', permission: [P.CHARGE_REQUEST_READ] },
    /*
     * ⚠️ "USAGE", AND IT IS A SEPARATE TAB FROM STOCK ON PURPOSE (PI-9). Stock
     *   says what the clinic HOLDS; this says what its procedures USED and how
     *   that compared with what was expected. They are different questions asked
     *   by different people — a storekeeper counts shelves, a clinical lead asks
     *   why a root canal is using twice the anaesthetic it is meant to — and the
     *   permissions say so: a doctor and a nurse hold `consumption.record.read`
     *   and deliberately hold no stock code at all, so folding this into Stock
     *   would put it behind a tab they cannot open.
     *
     * ⚠️ RECORDING IS NOT DONE FROM HERE. What a procedure used is recorded on
     *   the consultation it happened at, because the anchor is what makes the
     *   record traceable. This tab is the list, the variances and the templates.
     *
     * Sits after Charges because it is the other writer of that queue.
     */
    { href: '/usage', label: 'Usage', permission: [P.CONSUMPTION_READ] },
    /*
     * ⚠️ "CATALOGUE", NOT "PHARMACY" OR "PRODUCTS". One catalogue holds
     *   medicines, gloves, implants, reagents and dental materials, so naming
     *   the tab after any one of them tells four of the five kinds of user it is
     *   not for them (PI-ADR-001). "Products" is what the table is called;
     *   "Catalogue" is what the clinic calls the thing it opens.
     *
     * Sits after Invoices because it is what future invoice lines are drawn
     * from, and before the staff-facing tabs because a storekeeper works here
     * daily. Gated on `product.definition.read`, which a doctor and a nurse hold
     * for lookup and a receptionist does not.
     */
    { href: '/products', label: 'Catalogue', permission: [P.PRODUCT_DEFINITION_READ] },
    /*
     * ⚠️ "STOCK", NOT "INVENTORY", AND IT IS A SEPARATE TAB FROM CATALOGUE ON
     *   PURPOSE. The catalogue says what a thing IS; this says where it is and
     *   how much there is. They are different questions asked by the same person
     *   at different moments — a storekeeper curates the catalogue occasionally
     *   and counts the shelves every morning — and one tab holding both would
     *   bury the daily screen inside the occasional one.
     *
     *   "Inventory" is what the domain is called in the schema; "Stock" is what
     *   the clinic calls the thing it opens. Same choice as Catalogue over
     *   Products.
     *
     * Sits immediately after Catalogue because every row on it names a product,
     * and gated on `inventory.stock.read` — which a pharmacist and a branch
     * administrator hold, and a receptionist does not.
     */
    { href: '/stock', label: 'Stock', permission: [P.STOCK_READ] },
    /*
     * How stock GETS here, and what it cost (PI-4). The third tab of the same
     * triple: Catalogue says what a thing is, Stock says where it is, this says
     * who we bought it from.
     *
     * ⚠️ "BUYING", NOT "PROCUREMENT", FOR THE REASON "STOCK" IS NOT "INVENTORY".
     *   Procurement is what the domain is called in the schema and in the ADRs;
     *   buying is what the person opening it is doing. Same choice as Catalogue
     *   over Products, twice over.
     *
     * ⚠️ FOUR CODES, ANY OF WHICH MAKES THE TAB WORTH OPENING, AND THE SCREEN
     *   BEHIND IT RENDERS ONLY THE HALF THE CALLER HOLDS. A storekeeper who may
     *   only raise requisitions and a buyer who may only issue orders both belong
     *   here, and gating the tab on the widest code alone would hide it from one
     *   of them entirely.
     */
    {
      href: '/procurement/suppliers',
      label: 'Buying',
      permission: [
        P.SUPPLIER_MANAGE,
        P.PURCHASE_ORDER_READ,
        P.GOODS_RECEIPT_MANAGE,
        P.REQUISITION_CREATE,
      ],
    },
    /*
     * The counter (PI-7). The fourth tab of what is now a quartet: Catalogue says
     * what a thing is, Stock says where it is, Buying says who we bought it from,
     * and this is what happens when it leaves — into somebody's hand.
     *
     * ⚠️ "PHARMACY", AND NOT "DISPENSING" OR "COUNTER", WHICH IS THE OPPOSITE CALL
     *   FROM STOCK-OVER-INVENTORY. Every other rename in this list swaps a schema
     *   word for the clinic's word; here the clinic's word IS pharmacy — it is
     *   painted over the door and printed on the rota — while "dispensing" is what
     *   the domain calls the act.
     *
     * ⚠️ ANY OF THE FOUR CODES MAKES THE TAB WORTH OPENING, and the screens behind
     *   it render only the half the caller holds. A technician who may supply but
     *   not take returns belongs here as much as the pharmacist who does both.
     */
    {
      href: '/pharmacy',
      label: 'Pharmacy',
      permission: [P.DISPENSE_READ, P.DISPENSE_VERIFY, P.DISPENSE_CREATE, P.DISPENSE_RETURN],
    },
    /*
     * What the law allows to be done with the things in that catalogue (PI-5).
     *
     * ⚠️ "RULES", NOT "REGULATORY", the same choice as Stock over Inventory and
     *   Buying over Procurement. And the section is READ-ONLY at every clinic:
     *   the law of a country is maintained by rcln and is the same for everybody
     *   in it. A clinic's own regulatory work is on its products, under
     *   Catalogue, which is why there is no manage code in this list.
     */
    /*
     * When something has to come back off the shelf (PI-10).
     *
     * ⚠️ "PRODUCT RECALLS", BECAUSE "RECALL" IS ALREADY TAKEN — by the front
     *   desk's list of patients who were told to come back and have not (CE-5),
     *   twelve entries above. Two tabs called Recall would send the person
     *   chasing a contaminated implant to a list of missed follow-ups. The API
     *   keeps the shorter word; the screen takes the longer one, because a
     *   screen is read by somebody in a hurry.
     *
     * ⚠️ ITS OWN TAB RATHER THAN A SCREEN INSIDE STOCK, AND THE REASON IS THE ONE
     *   USAGE GIVES. Stock says what the clinic HOLDS; a recall is a piece of
     *   WORK with a beginning and an end, spanning every branch, whose second
     *   half is contacting people who already received the product. Folding it
     *   into Stock would file "who has this implant" beside "how many boxes are
     *   in the fridge".
     *
     * ⚠️ AND IT IS FINDABLE WHEN NOTHING IS WRONG, WHICH IS THE POINT. "Trace a
     *   lot" is opened about a suspicious delivery or a device that failed, long
     *   before anybody decides there is a recall — a tab that only appeared once
     *   a notice existed would be a tab nobody could find on the day they need
     *   it.
     *
     * Sits after Pharmacy because it is what happens when something that left
     * has to be reached again. Gated on `recall.notice.read`, which a pharmacist
     * and a branch administrator hold.
     */
    { href: '/product-recalls', label: 'Product recalls', permission: [P.RECALL_READ] },
    { href: '/regulatory/jurisdictions', label: 'Rules', permission: [P.REGULATORY_READ] },
    /*
     * The clinical vocabulary. Sits after Rules rather than beside Patients
     * because it is a SETTINGS surface — nobody opens it during a clinic. Read
     * behind `appointment.read` for the reason the route file gives: every
     * clinical picker needs these names, so gating the dictionary behind the
     * permission to EDIT it shows a receptionist blanks.
     */
    {
      href: '/clinical-terms',
      label: 'Clinical terms',
      permission: [P.APPOINTMENT_READ],
    },
    /*
     * What a consultation is MADE OF, as opposed to the words it is written in
     * (CE-2). Its own entry rather than a panel on Clinical terms, because the
     * two answer different questions and are held by different people: anyone
     * who can read an appointment reads the vocabulary, and only
     * `clinical.template.manage` configures the consultation.
     */
    {
      href: '/consultation-templates',
      label: 'Consultations',
      permission: [P.CLINICAL_TEMPLATE_MANAGE],
    },
    /*
     * The pictures those consultations draw ON (CE-6). Its own entry rather than
     * a panel on Consultations, because the two are held by different codes on
     * purpose: a clinic may let somebody rearrange the sections of its dentistry
     * form without letting them redraw the tooth numbering every record in the
     * practice is written against.
     */
    {
      href: '/visual-maps',
      label: 'Charts',
      permission: [P.CLINICAL_VISUAL_MAP_MANAGE],
    },
    /*
     * The rate card BEHIND those invoices. A separate tab rather than a panel on
     * the Clinic screen, because `settings.organization.read` is not the
     * permission that guards it: a clock format is a preference and a tax rate
     * decides what every patient is charged. Read and manage are separate codes;
     * either makes the screen worth opening.
     */
    /*
     * What all of that adds up to (PI-22). Nine reads over the tables the stock,
     * buying, counter and consultation tabs write — and not one of them stores
     * an answer.
     *
     * ⚠️ FOUR CODES, ANY OF WHICH MAKES THE TAB WORTH OPENING, AND THE MENU
     *   BEHIND IT RENDERS ONLY THE REPORTS THE CALLER HOLDS. `report.dashboard.read`
     *   is what actually gates the menu, but a clinic that grants an accountant
     *   `report.revenue.read` alone and forgets the dashboard code would hide the
     *   tab from the one person it was granted for — so the tab appears for any
     *   of them and the screen says which are open. `REPORT_EXPORT` is the fifth
     *   report code and is deliberately NOT here: it lets somebody download a
     *   report, not read one, so on its own it opens an empty tab. (The comment
     *   said "five" and listed four — PI-24 review.)
     *
     * ⚠️ ITS OWN TAB RATHER THAN A PANEL ON STOCK, FOR THE REASON PRODUCT RECALLS
     *   IS ITS OWN TAB. Stock says what the clinic HOLDS right now; a report is a
     *   statement about a MOMENT or a PERIOD, printed, filed and compared against
     *   next year's. Folding it into Stock would file "what did March cost us"
     *   beside "how many boxes are in the fridge".
     *
     * Sits after Rules and before Tax: it is the last thing in the operational
     * run and the first thing an accountant opens.
     */
    {
      href: '/reports',
      label: 'Reports',
      permission: [P.REPORT_DASHBOARD, P.REPORT_INVENTORY, P.REPORT_CLINICAL, P.REPORT_REVENUE],
    },
    { href: '/taxes', label: 'Tax', permission: [P.BILLING_TAX_READ] },
    { href: '/members', label: 'Staff', permission: [P.IAM_USER_READ] },
    { href: '/roles', label: 'Roles', permission: [P.IAM_ROLE_READ] },
    { href: '/invitations', label: 'Invitations', permission: [P.IAM_USER_READ] },
    // Two codes, either of which makes the screen worth opening: it holds the
    // clinic's particulars and its defaults behind separate permissions, and
    // renders whichever half the API answered.
    {
      href: '/settings',
      label: 'Clinic',
      permission: [P.ORG_READ, P.SETTINGS_ORG_READ],
    },
    // Reading the plan and the invoices is a different permission from changing
    // them; either one makes the screen worth opening, and the screen itself
    // renders only the controls the caller may use.
    {
      href: '/billing',
      label: 'Billing',
      permission: [P.ORG_BILLING_READ, P.ORG_BILLING_MANAGE],
    },
  ]
    .filter((link) => link.permission.some((code) => permissions.includes(code)))
    .map(({ href, label }) => ({ href, label }));
}
