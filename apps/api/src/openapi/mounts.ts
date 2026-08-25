/**
 * Where each router is mounted, and which section of the documentation it is.
 *
 * ⚠️ THE ONE HAND-MAINTAINED LIST IN THIS MODULE, AND IT EXISTS ONLY BECAUSE
 *   EXPRESS 5 THROWS THE INFORMATION AWAY. A `Layer` compiles its mount path
 *   into a matcher function and keeps no copy of the string, so `/procurement/
 *   purchase-orders` is not recoverable from the running app by any means. The
 *   prefixes below therefore restate what `routes/index.ts`, `routes/v1/index.ts`
 *   and `app.ts` register.
 *
 * ⚠️ AND IT IS CHECKED AGAINST THE APP BY OBJECT IDENTITY, NOT BY EYE. Every
 *   entry names the same router OBJECT the app mounts, so `assertMountsCover()`
 *   can compare the two sets directly: a router mounted in `v1/index.ts` and
 *   forgotten here is a failing test, not an endpoint that quietly never
 *   appears in the documentation. That is the failure mode this file would
 *   otherwise have, and it is invisible in a diff — the new route file looks
 *   complete, the docs simply do not mention it.
 */
import type { IRouter } from 'express';

import auditRoutes from '../routes/v1/audit.routes.js';
import authRoutes from '../routes/v1/auth.routes.js';
import billingRoutes from '../routes/v1/billing.routes.js';
import appointmentRoutes from '../routes/v1/appointments.routes.js';
import branchRoutes from '../routes/v1/branches.routes.js';
import chargingRoutes from '../routes/v1/charging.routes.js';
import clinicalTaxonomyRoutes from '../routes/v1/clinical-taxonomy.routes.js';
import clinicalRoutes from '../routes/v1/clinical.routes.js';
import consultationTemplateRoutes from '../routes/v1/consultation-templates.routes.js';
import consumptionRoutes from '../routes/v1/consumption.routes.js';
import designationRoutes from '../routes/v1/designations.routes.js';
import doctorRoutes from '../routes/v1/doctors.routes.js';
import encounterRoutes from '../routes/v1/encounters.routes.js';
import feeRoutes from '../routes/v1/fees.routes.js';
import healthRoutes from '../routes/v1/health.routes.js';
import invitationRoutes from '../routes/v1/invitations.routes.js';
import invoiceRoutes from '../routes/v1/invoices.routes.js';
import memberRoutes from '../routes/v1/members.routes.js';
import organizationRoutes from '../routes/v1/organization.routes.js';
import patientRoutes from '../routes/v1/patients.routes.js';
import pharmacyRoutes from '../routes/v1/pharmacy.routes.js';
import onlineOrderRoutes from '../routes/v1/online-pharmacy.routes.js';
import platformRoutes from '../routes/v1/platform.routes.js';
import productRoutes from '../routes/v1/products.routes.js';
import publicRoutes from '../routes/v1/public.routes.js';
import regulatoryRoutes from '../routes/v1/regulatory.routes.js';
import reportRoutes from '../routes/v1/reports.routes.js';
import roleRoutes from '../routes/v1/roles.routes.js';
import taxRoutes from '../routes/v1/tax.routes.js';
import visualMapRoutes from '../routes/v1/visual-maps.routes.js';
import webhookRoutes from '../routes/v1/webhooks.routes.js';
import { recallRoutes, traceabilityRoutes } from '../routes/v1/recalls.routes.js';
import {
  batchRoutes,
  inventoryLocationRoutes,
  serialRoutes,
  stockRoutes,
  stockTransferRoutes,
} from '../routes/v1/inventory.routes.js';
import {
  costAverageRoutes,
  goodsReceiptRoutes,
  purchaseOrderRoutes,
  purchaseReturnRoutes,
  requisitionRoutes,
  supplierProductRoutes,
  supplierRoutes,
} from '../routes/v1/procurement.routes.js';
import {
  activeIngredientRoutes,
  compositionRoutes,
  manufacturerRoutes,
  productCategoryRoutes,
  storageProfileRoutes,
  unitRoutes,
} from '../routes/v1/product-catalogue.routes.js';

/** The documentation's own sections, in the order a reader should meet them. */
export const TAGS = [
  'Health',
  'Authentication',
  'Public',
  'Organization',
  'Branches',
  'Members & Roles',
  'Doctors',
  'Patients',
  'Appointments',
  'Clinical record',
  'Clinical configuration',
  'Product catalogue',
  'Inventory',
  'Procurement',
  'Pharmacy',
  'Regulatory',
  'Charging & consumption',
  'Invoicing & tax',
  'Recall & traceability',
  'Reports',
  'Billing (subscription)',
  'Audit',
  'Platform admin',
  'Webhooks',
] as const;

export type Tag = (typeof TAGS)[number];

export interface Mount {
  /** The full prefix a caller types, including `/api/v1`. */
  readonly prefix: string;
  readonly router: IRouter;
  readonly tag: Tag;
}

const V1 = '/api/v1';

export const MOUNTS: readonly Mount[] = [
  { prefix: `${V1}/health`, router: healthRoutes, tag: 'Health' },
  { prefix: `${V1}/auth`, router: authRoutes, tag: 'Authentication' },
  { prefix: `${V1}/public`, router: publicRoutes, tag: 'Public' },
  { prefix: `${V1}/platform`, router: platformRoutes, tag: 'Platform admin' },
  { prefix: `${V1}/organization`, router: organizationRoutes, tag: 'Organization' },
  { prefix: `${V1}/branches`, router: branchRoutes, tag: 'Branches' },
  { prefix: `${V1}/invitations`, router: invitationRoutes, tag: 'Members & Roles' },
  { prefix: `${V1}/roles`, router: roleRoutes, tag: 'Members & Roles' },
  { prefix: `${V1}/members`, router: memberRoutes, tag: 'Members & Roles' },
  { prefix: `${V1}/designations`, router: designationRoutes, tag: 'Members & Roles' },
  { prefix: `${V1}/doctors`, router: doctorRoutes, tag: 'Doctors' },
  { prefix: `${V1}/clinical-taxonomy`, router: clinicalTaxonomyRoutes, tag: 'Doctors' },
  { prefix: `${V1}/patients`, router: patientRoutes, tag: 'Patients' },
  { prefix: `${V1}/appointments`, router: appointmentRoutes, tag: 'Appointments' },

  /*
   * ⚠️ MOUNTED AT THE ROOT, SO ITS ROUTES CARRY THEIR OWN FIRST SEGMENT. It
   *   serves `/clinical-data` and `/clinical-episodes`, which is why v1/index.ts
   *   mounts it on `/` rather than folding a dictionary and PHI under one prefix.
   */
  { prefix: V1, router: clinicalRoutes, tag: 'Clinical record' },
  { prefix: `${V1}/encounters`, router: encounterRoutes, tag: 'Clinical record' },
  {
    prefix: `${V1}/consultation-templates`,
    router: consultationTemplateRoutes,
    tag: 'Clinical configuration',
  },
  { prefix: `${V1}/visual-maps`, router: visualMapRoutes, tag: 'Clinical configuration' },

  { prefix: `${V1}/products`, router: productRoutes, tag: 'Product catalogue' },
  { prefix: `${V1}/units`, router: unitRoutes, tag: 'Product catalogue' },
  { prefix: `${V1}/product-categories`, router: productCategoryRoutes, tag: 'Product catalogue' },
  { prefix: `${V1}/manufacturers`, router: manufacturerRoutes, tag: 'Product catalogue' },
  { prefix: `${V1}/active-ingredients`, router: activeIngredientRoutes, tag: 'Product catalogue' },
  { prefix: `${V1}/compositions`, router: compositionRoutes, tag: 'Product catalogue' },
  { prefix: `${V1}/storage-profiles`, router: storageProfileRoutes, tag: 'Product catalogue' },

  { prefix: `${V1}/inventory-locations`, router: inventoryLocationRoutes, tag: 'Inventory' },
  { prefix: `${V1}/batches`, router: batchRoutes, tag: 'Inventory' },
  { prefix: `${V1}/serials`, router: serialRoutes, tag: 'Inventory' },
  { prefix: `${V1}/stock`, router: stockRoutes, tag: 'Inventory' },
  { prefix: `${V1}/stock-transfers`, router: stockTransferRoutes, tag: 'Inventory' },

  { prefix: `${V1}/procurement/suppliers`, router: supplierRoutes, tag: 'Procurement' },
  {
    prefix: `${V1}/procurement/supplier-products`,
    router: supplierProductRoutes,
    tag: 'Procurement',
  },
  { prefix: `${V1}/procurement/requisitions`, router: requisitionRoutes, tag: 'Procurement' },
  { prefix: `${V1}/procurement/purchase-orders`, router: purchaseOrderRoutes, tag: 'Procurement' },
  { prefix: `${V1}/procurement/goods-receipts`, router: goodsReceiptRoutes, tag: 'Procurement' },
  { prefix: `${V1}/procurement/returns`, router: purchaseReturnRoutes, tag: 'Procurement' },
  { prefix: `${V1}/procurement/cost-averages`, router: costAverageRoutes, tag: 'Procurement' },

  { prefix: `${V1}/regulatory`, router: regulatoryRoutes, tag: 'Regulatory' },
  { prefix: `${V1}/pharmacy`, router: pharmacyRoutes, tag: 'Pharmacy' },
  { prefix: `${V1}/online-orders`, router: onlineOrderRoutes, tag: 'Pharmacy' },
  { prefix: `${V1}/charging`, router: chargingRoutes, tag: 'Charging & consumption' },
  { prefix: `${V1}/consumption`, router: consumptionRoutes, tag: 'Charging & consumption' },
  { prefix: `${V1}/recalls`, router: recallRoutes, tag: 'Recall & traceability' },
  { prefix: `${V1}/traceability`, router: traceabilityRoutes, tag: 'Recall & traceability' },

  { prefix: `${V1}/reports`, router: reportRoutes, tag: 'Reports' },

  { prefix: `${V1}/invoices`, router: invoiceRoutes, tag: 'Invoicing & tax' },
  { prefix: `${V1}/tax`, router: taxRoutes, tag: 'Invoicing & tax' },
  { prefix: `${V1}/fee-schedule`, router: feeRoutes, tag: 'Invoicing & tax' },
  { prefix: `${V1}/billing`, router: billingRoutes, tag: 'Billing (subscription)' },

  { prefix: `${V1}/audit`, router: auditRoutes, tag: 'Audit' },

  /*
   * Mounted directly on the app, ahead of the body parsers, because a provider
   * signs the exact bytes it sent. See the header of webhooks.routes.ts.
   */
  { prefix: `${V1}/webhooks`, router: webhookRoutes, tag: 'Webhooks' },
];

/**
 * Every router the app mounts is declared above, and nothing above is stale.
 *
 * Called by the OpenAPI test rather than at boot: a mismatch is a documentation
 * bug, and refusing to start the API over one would be the wrong trade.
 */
export function assertMountsCover(reachable: ReadonlySet<IRouter>): void {
  const declared = new Set(MOUNTS.map((mount) => mount.router));

  const undocumented = [...reachable].filter((router) => !declared.has(router));
  const stale = [...declared].filter((router) => !reachable.has(router));

  const problems: string[] = [];
  if (undocumented.length > 0) {
    problems.push(
      `${String(undocumented.length)} router(s) are mounted on the app but absent from MOUNTS, so their endpoints are missing from the OpenAPI document`
    );
  }
  if (stale.length > 0) {
    problems.push(
      `${String(stale.length)} entr(y/ies) in MOUNTS name a router the app no longer mounts`
    );
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
}
