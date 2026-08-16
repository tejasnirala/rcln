import { Router, type IRouter } from 'express';
import auditRoutes from './audit.routes.js';
import authRoutes from './auth.routes.js';
import billingRoutes from './billing.routes.js';
import appointmentRoutes from './appointments.routes.js';
import branchRoutes from './branches.routes.js';
import clinicalTaxonomyRoutes from './clinical-taxonomy.routes.js';
import clinicalRoutes from './clinical.routes.js';
import consultationTemplateRoutes from './consultation-templates.routes.js';
import visualMapRoutes from './visual-maps.routes.js';
import encounterRoutes from './encounters.routes.js';
import feeRoutes from './fees.routes.js';
import healthRoutes from './health.routes.js';
import invoiceRoutes from './invoices.routes.js';
import taxRoutes from './tax.routes.js';
import invitationRoutes from './invitations.routes.js';
import doctorRoutes from './doctors.routes.js';
import designationRoutes from './designations.routes.js';
import memberRoutes from './members.routes.js';
import organizationRoutes from './organization.routes.js';
import patientRoutes from './patients.routes.js';
import productRoutes from './products.routes.js';
import {
  batchRoutes,
  inventoryLocationRoutes,
  serialRoutes,
  stockRoutes,
  stockTransferRoutes,
} from './inventory.routes.js';
import {
  costAverageRoutes,
  goodsReceiptRoutes,
  purchaseOrderRoutes,
  purchaseReturnRoutes,
  requisitionRoutes,
  supplierProductRoutes,
  supplierRoutes,
} from './procurement.routes.js';
import {
  activeIngredientRoutes,
  compositionRoutes,
  manufacturerRoutes,
  productCategoryRoutes,
  storageProfileRoutes,
  unitRoutes,
} from './product-catalogue.routes.js';
import regulatoryRoutes from './regulatory.routes.js';
import platformRoutes from './platform.routes.js';
import publicRoutes from './public.routes.js';
import roleRoutes from './roles.routes.js';

const router: IRouter = Router();

router.use('/health', healthRoutes);

// Sign-in. Deliberately NOT behind requireTenant — it must also serve the apex
// and admin hosts, where a platform admin has no tenant. See auth.routes.ts.
router.use('/auth', authRoutes);

// Apex-domain marketing site. Unauthenticated and pre-tenant on purpose —
// see the header comment in public.routes.ts before adding anything here.
router.use('/public', publicRoutes);

// Super-admin console on admin.<root-domain>. Outside every tenant; gated on
// users.is_platform_admin, which answers 404 rather than 403. Impersonation
// STARTS here and is redeemed on /auth, because only the clinic's own host can
// be given a session cookie for it — see impersonation.service.ts.
router.use('/platform', platformRoutes);

// A clinic's own subdomain. The first router behind requireTenant, and the
// template for the tenant-scoped routers that follow it.
router.use('/branches', branchRoutes);

// Issuing invitations. Accepting one is on /auth, because the person accepting
// has no membership here yet — see the header of invitations.routes.ts.
router.use('/invitations', invitationRoutes);

// Doctors and their working hours — the input the availability engine reads.
// Carries no PHI: a doctor is staff, not a patient.
router.use('/doctors', doctorRoutes);

// What a practitioner is TRAINED IN — the hierarchical classification tree.
// Its own surface rather than a path under /doctors, because a procedure and a
// service will reference these nodes too: the taxonomy outlives the one screen
// that first needed it. Reads sit behind DOCTOR_READ so every screen showing a
// doctor can render their specialty name; curation is DOCTOR_MASTER_MANAGE.
router.use('/clinical-taxonomy', clinicalTaxonomyRoutes);
/*
 * Mounted at the ROOT rather than under a prefix, because it serves two
 * unrelated paths — `/clinical-data` (the vocabulary) and `/clinical-episodes`
 * (a patient's treatment journeys). Folding them under one prefix would put a
 * dictionary and PHI behind the same-looking URL, and the brief names both
 * paths as they are (§32).
 */
router.use('/', clinicalRoutes);

/*
 * The consultation CONFIGURATION (CE-2) — which sections a consultation has, in
 * what order, over which vocabulary.
 *
 * ⚠️ ITS OWN SURFACE, AND BEHIND ITS OWN CODE. `clinical.template.manage` gates
 *   the whole surface in both directions, unlike the vocabulary above: nobody
 *   needs the template list except the person configuring it. A doctor reads the
 *   RESOLVED configuration from `GET /appointments/:id/consultation-config`,
 *   behind `clinical.encounter.read`, which they already hold.
 */
router.use('/consultation-templates', consultationTemplateRoutes);

/*
 * The charts a consultation draws ON (CE-6). Same posture as the templates
 * above and for the same reason: a map names no patient, and nobody needs the
 * map list except the person configuring one — a doctor gets the chart already
 * resolved onto the consultation.
 *
 * ⚠️ AND ITS OWN CODE RATHER THAN `clinical.template.manage`. A template says
 *   WHICH chart appears; this says what the chart IS, and a clinic may
 *   reasonably separate the two.
 */
router.use('/visual-maps', visualMapRoutes);

/*
 * The consultation ITSELF (CE-3) — what the doctor recorded, not what the form
 * looks like.
 *
 * ⚠️ THE OPPOSITE PHI POSTURE FROM THE TEMPLATES ABOVE. Every response here is a
 *   clinical statement about a named person: every read writes a
 *   `data_access_logs` row, and each verb sits behind its own code, with the
 *   authoring set held by DOCTOR alone among the system roles (invariant 7).
 */
router.use('/encounters', encounterRoutes);

// Job titles. Its own surface rather than a path under /members, which would be
// swallowed by /members/:membershipId.
router.use('/designations', designationRoutes);

// ⚠️ THE FIRST PHI SURFACE. Every read under here writes a `data_access_logs`
// row, and `patients` deliberately carries NO branch_isolation policy — the
// branch boundary is on `patient_registrations` instead (ADR-0016). Read the
// header of patients.routes.ts before adding an endpoint to it.
router.use('/patients', patientRoutes);

// Bookings, and the availability engine behind them. PHI too: a patient, a
// doctor and a reason disclose more together than any one of them does. Unlike
// `patients`, `appointments` IS branch-scoped — identity follows the person,
// attendance belongs to the clinic it happened at.
router.use('/appointments', appointmentRoutes);

// WHAT A THING IS — one catalogue for medicines, gloves, implants, reagents and
// dental materials (PI-ADR-001). Deliberately NOT under /pharmacy: a dentist
// maintains dental materials and a lab manager maintains reagents, and neither
// should need a pharmacy permission to do it. Nothing here carries a quantity —
// where stock is and how much of it exists is PI-2's `stock_ledger`.
//
// ⚠️ Not PHI today. It becomes PHI-adjacent the moment dispensing links a
//    product to a named person (PI-ADR-016), and that will be its own router.
router.use('/products', productRoutes);

// The masters a product points at. Their own top-level surfaces rather than
// paths under /products, because a purchase order, a batch and a supplier
// catalogue will all reference them too — they outlive the one screen that
// first needed them, exactly as /clinical-taxonomy does for doctors.
//
// Reads sit behind `product.definition.read` so every screen showing a product
// can render its category and unit NAME; curation is `product.definition.manage`.
router.use('/units', unitRoutes);
router.use('/product-categories', productCategoryRoutes);
router.use('/manufacturers', manufacturerRoutes);
router.use('/active-ingredients', activeIngredientRoutes);
router.use('/compositions', compositionRoutes);
router.use('/storage-profiles', storageProfileRoutes);

// Inventory (PI-2): where stock IS and how much of it there is. The other half
// of the catalogue above, and the opposite tenancy class — nothing here allows a
// NULL organization_id, and every table is branch-scoped as well (PI-ADR-003).
//
// ⚠️ `/serials` IS A PHI SURFACE. `assigned_patient_id` answers "which patient
//    has device 7742", so its reads write `data_access_logs` (PI-ADR-016). The
//    other three do not touch a patient at all.
//
// ⚠️ `/stock/movements` IS NOT THE ONLY HTTP WRITE INTO `stock_ledger` ANY MORE,
//    AND IT IS STILL THE ONLY ONE THAT TAKES A MOVEMENT TYPE. It accepts the
//    manual types only; `/stock-transfers/*` and `/stock/reservations` (PI-3)
//    write movements too, and each writes a PAIR or a status transition whose
//    type the caller never names. Dispensing (PI-7), consumption (PI-9) and
//    goods receipts (PI-4) will do the same. Every one of them goes through
//    `recordMovementIn`; PI-ADR-004 is about the WRITER, not the route.
router.use('/inventory-locations', inventoryLocationRoutes);
router.use('/batches', batchRoutes);
router.use('/serials', serialRoutes);
router.use('/stock', stockRoutes);
// Movements (PI-3). A transfer is the one document in the programme belonging to
// TWO branches, so it sits at the top level rather than under a branch-scoped
// path — and its RLS policy is the bespoke `from OR to` one, not the generic
// branch predicate. See the StockTransfer model.
router.use('/stock-transfers', stockTransferRoutes);

// Procurement (PI-4): how stock ENTERS the system, and where cost comes from. The
// third side of the pair above — the catalogue says what a thing IS, inventory says
// where it is, and this says who we bought it from and what we paid.
//
// ⚠️ NESTED UNDER `/procurement` RATHER THAN `/pharmacy`, AND THE PERMISSION CODES
//    ARE THE INCONSISTENCY THIS DOES NOT FIX. Under PI-ADR-001 procurement is not a
//    pharmacy concern — a dental store manager requisitions filling material and a
//    lab manager requisitions reagents — so the PATH is neutral. Three of the codes
//    are still `pharmacy.supplier.*` and `pharmacy.purchase_order.*` because they
//    predate that reasoning, and renaming a code revokes it from every clinic that
//    already holds it. Recorded in KNOWN_ISSUES rather than done silently.
//
// ⚠️ `/goods-receipts/:id/post` IS THE ONE ENDPOINT HERE THAT WRITES `stock_ledger`,
//    and it writes every leg, every lot row, every serial and the cost roll-up in
//    ONE transaction. Everything else under `/procurement` is paperwork —
//    PI-ADR-004 is about the WRITER, not the route, and that endpoint goes through
//    `recordMovementIn` like every other.
//
// Not PHI. A goods receipt CREATES serials and a return refuses one that has been
// issued to a patient; neither ever returns `serials.assigned_patient_id`.
router.use('/procurement/suppliers', supplierRoutes);
router.use('/procurement/supplier-products', supplierProductRoutes);
router.use('/procurement/requisitions', requisitionRoutes);
router.use('/procurement/purchase-orders', purchaseOrderRoutes);
router.use('/procurement/goods-receipts', goodsReceiptRoutes);
router.use('/procurement/returns', purchaseReturnRoutes);
router.use('/procurement/cost-averages', costAverageRoutes);

// WHAT THE LAW ALLOWS — jurisdictions, regulators, rule packs and the engine that
// reads them (PI-5). Read-only from a clinic: every table behind it is PLATFORM
// data with no organization_id, the maintenance console lives on the admin host,
// and the database refuses a write from any transaction claiming a tenant.
//
// ⚠️ `POST /regulatory/evaluate` ANSWERS A QUESTION AND AUTHORISES NOTHING. It is
//    gated on the READ code deliberately; whoever ACTS on a decision (PI-7's
//    dispensing) is gated on the code for that act and re-evaluates server-side
//    rather than trusting a decision a client hands back.
//
// ⚠️ NOT WIRED INTO GOODS RECEIPT OR TRANSFER YET, on purpose. With no rule pack
//    configured anywhere every decision is UNDETERMINED — which REFUSES — so
//    enforcing it today would stop every clinic receiving stock. PI-6 configures
//    the first jurisdiction and wires the call sites as it reaches
//    `RULES_IMPLEMENTED`.
//
// Not PHI: the evaluation request carries an age and a subject type, never a
// patient id.
router.use('/regulatory', regulatoryRoutes);

// Custom roles, and who holds what. Both act on rows that carry a RESTRICTIVE
// branch_isolation policy, where an out-of-scope write is a silent no-op rather
// than an error — see services/iam/guards.ts.
router.use('/roles', roleRoutes);
router.use('/members', memberRoutes);

// The clinic's own record, and its settings. Singular and with no id in the
// path: which organization this is was decided by the Host header. Both tables
// behind it are RLS-EXEMPT, so the scoping is entirely in the service — read the
// headers of organization.service.ts and setting.service.ts before touching it.
router.use('/organization', organizationRoutes);

// What the clinic pays and how. Reading and changing it are separate
// permissions, because downloading last month's invoice and cancelling the
// subscription are not the same decision.
//
// The provider's side of this is NOT here: webhooks are mounted directly on the
// app, ahead of the body parsers, because they must see the raw bytes they were
// signed over. See the header of webhooks.routes.ts.
router.use('/billing', billingRoutes);

// What the clinic bills a PATIENT — and deliberately NOT under /billing, which
// is the subscription rcln charges the clinic for. Two documents, two tables,
// two lifecycles; §0.1 of the invoice-engine log is why they can never share
// one. PHI, so every read here writes a `data_access_logs` row, and WHICH
// invoices a caller sees is derived from the modules they work in rather than
// from a permission code per source. Read the header of invoices.routes.ts.
router.use('/invoices', invoiceRoutes);

// What the clinic charges, and the registrations it charges under. The rate card
// BEHIND the invoices above, and the first write path `issuer_tax_registrations`
// and `tax_rules` have ever had — every clinic until now ran entirely on rcln's
// published catalogue. Not PHI and not under /platform, which maintains that
// catalogue for every clinic at once. See tax.routes.ts.
router.use('/tax', taxRoutes);

// What a VISIT costs, by kind of visit — the clinic's defaults, and the
// per-doctor overrides that sit under /doctors/:doctorId/fees. Not under /tax,
// which is what the government takes off a price, and not under /invoices,
// which is a bill that already exists. This is what every future bill will say,
// and it is quoted at the front desk before a patient has agreed to anything.
router.use('/fee-schedule', feeRoutes);

// A record's own history, for any record in this clinic. Read-only, and the only
// way rows leave `audit_logs` — which is append-only at the database, not merely
// by convention. See audit.routes.ts.
router.use('/audit', auditRoutes);

export default router;
