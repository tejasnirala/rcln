import type { AuthSession } from '@rcln/contracts';
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
    { href: '/branches', label: 'Branches', permission: ['branch.read'] },
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
    { href: '/doctors', label: 'Doctors', permission: ['doctor.directory.read'] },
    // First in the list that is about the people being treated rather than the
    // people doing the treating, and the only destination behind it that
    // discloses PHI. Every screen under it writes a `data_access_logs` row.
    { href: '/patients', label: 'Patients', permission: ['patient.read'] },
    // Sits after Patients because it is about them, and before Staff because it
    // is the screen the front desk actually works from all day.
    { href: '/appointments', label: 'Appointments', permission: ['appointment.read'] },
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
    { href: '/recall', label: 'Recall', permission: ['appointment.read'] },
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
    { href: '/invoices', label: 'Invoices', permission: ['billing.invoice.read'] },
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
    { href: '/charges', label: 'Charges', permission: ['billing.charge_request.read'] },
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
    { href: '/products', label: 'Catalogue', permission: ['product.definition.read'] },
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
    { href: '/stock', label: 'Stock', permission: ['inventory.stock.read'] },
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
        'pharmacy.supplier.manage',
        'pharmacy.purchase_order.read',
        'pharmacy.goods_receipt.manage',
        'procurement.requisition.create',
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
      permission: [
        'pharmacy.dispense.read',
        'pharmacy.dispense.verify',
        'pharmacy.dispense.create',
        'pharmacy.dispense.return',
      ],
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
    { href: '/regulatory/jurisdictions', label: 'Rules', permission: ['regulatory.rule.read'] },
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
      permission: ['appointment.read'],
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
      permission: ['clinical.template.manage'],
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
      permission: ['clinical.visual_map.manage'],
    },
    /*
     * The rate card BEHIND those invoices. A separate tab rather than a panel on
     * the Clinic screen, because `settings.organization.read` is not the
     * permission that guards it: a clock format is a preference and a tax rate
     * decides what every patient is charged. Read and manage are separate codes;
     * either makes the screen worth opening.
     */
    { href: '/taxes', label: 'Tax', permission: ['billing.tax.read'] },
    { href: '/members', label: 'Staff', permission: ['iam.user.read'] },
    { href: '/roles', label: 'Roles', permission: ['iam.role.read'] },
    { href: '/invitations', label: 'Invitations', permission: ['iam.user.read'] },
    // Two codes, either of which makes the screen worth opening: it holds the
    // clinic's particulars and its defaults behind separate permissions, and
    // renders whichever half the API answered.
    {
      href: '/settings',
      label: 'Clinic',
      permission: ['organization.read', 'settings.organization.read'],
    },
    // Reading the plan and the invoices is a different permission from changing
    // them; either one makes the screen worth opening, and the screen itself
    // renders only the controls the caller may use.
    {
      href: '/billing',
      label: 'Billing',
      permission: ['organization.billing.read', 'organization.billing.manage'],
    },
  ]
    .filter((link) => link.permission.some((code) => permissions.includes(code)))
    .map(({ href, label }) => ({ href, label }));
}
