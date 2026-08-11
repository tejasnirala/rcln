/**
 * Medicine-specific attributes: the 1:1 extension row on a product.
 *
 * ── WHY AN EXTENSION TABLE AND NOT COLUMNS ON `products` (PI-ADR-001) ────────
 * A glove has no dosage form. Putting `dosage_form`, `route` and `release_type`
 * on `products` means four nullable columns that are NULL for most of the
 * catalogue, and every query filtering on them has to remember that NULL means
 * "not a medicine" rather than "not recorded". One row that exists or does not
 * is a clearer statement, and it keeps inventory reading a single table.
 *
 * ── GATED BY `pharmacy.medicine.manage`, NOT `product.definition.manage` ─────
 * This is the narrower half of the PI-ADR-011 split. A lab manager maintains
 * reagents and a dental store manager maintains materials — both hold
 * `product.definition.manage` and neither should be setting a prescription
 * classification. See the route file.
 *
 * ⚠️ `prescriptionClassificationHint` IS A HINT AND MUST NEVER GATE A DISPENSE.
 *   Whether a product requires a prescription is a per-jurisdiction regulatory
 *   fact that lands in PI-5 as `product_regulatory_profiles`, evaluated by a pure
 *   function that refuses when it has no rule. This column exists so a clinic can
 *   record what it believes in the meantime, and so PI-5 has somewhere to migrate
 *   from. Any code that reads it to decide whether dispensing is permitted has
 *   reimplemented the regulatory engine badly, in one place, with no source
 *   citation and no version.
 *
 * NO PHI. A dosage form is not a patient — that changes when a dispense links
 * this product to a person (PI-ADR-016).
 */
import { withTenant, type TenantContext } from '@rcln/db';
import type { MedicineDetail, MedicineDetailRequest } from '@rcln/contracts';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import type { CatalogueActionOptions } from './unit.service.js';

function toDetail(row: {
  id: string;
  productId: string;
  dosageForm: MedicineDetail['dosageForm'];
  route: MedicineDetail['route'];
  releaseType: MedicineDetail['releaseType'];
  isNarrowTherapeuticIndex: boolean;
  prescriptionClassificationHint: string | null;
  labelInstructions: string | null;
  defaultCourseDays: number | null;
}): MedicineDetail {
  return {
    id: row.id,
    productId: row.productId,
    dosageForm: row.dosageForm,
    route: row.route,
    releaseType: row.releaseType,
    isNarrowTherapeuticIndex: row.isNarrowTherapeuticIndex,
    prescriptionClassificationHint: row.prescriptionClassificationHint,
    labelInstructions: row.labelInstructions,
    defaultCourseDays: row.defaultCourseDays,
  };
}

export async function getMedicineDetail(
  ctx: TenantContext,
  productId: string
): Promise<MedicineDetail | null> {
  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, deletedAt: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');

    const row = await tx.medicineDetail.findFirst({ where: { productId } });
    // `null` rather than a 404: "this product has no medicine detail" is an
    // ordinary answer for a glove, and the screen renders an empty tab.
    return row ? toDetail(row) : null;
  });
}

/**
 * Create or replace the medicine detail. Idempotent by product.
 *
 * An upsert rather than separate create and update routes, because the row's
 * existence is an implementation detail of "does this product have medicine
 * attributes recorded" — a caller filling in the form should not have to know
 * whether somebody filled it in before.
 */
export async function upsertMedicineDetail(
  ctx: TenantContext,
  productId: string,
  input: MedicineDetailRequest,
  options: CatalogueActionOptions = {}
): Promise<MedicineDetail> {
  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, organizationId: true, deletedAt: true, type: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');

    if (product.organizationId === null) {
      throw new ValidationError(
        'This product is part of the platform catalogue. Copy it into your own catalogue before editing its medicine details.'
      );
    }

    /*
     * ⚠️ NOT GATED ON `type === 'MEDICINE'`, DELIBERATELY, AND THIS IS THE SAME
     *   TRAP THE ENUM CARRIES A WARNING ABOUT. A vaccine has a route, a dental
     *   anaesthetic has a dosage form, and a veterinary medicine has both — so a
     *   check on the discriminator would refuse legitimate records for three
     *   types that plainly need them, and would need extending every time a
     *   member is added. `ProductType` is metadata for grouping, not a gate.
     *
     *   What IS refused is the case with no meaning at all: recording a dosage
     *   form on something that is not administered to anybody.
     */
    if (product.type === 'CONSUMABLE' || product.type === 'SURGICAL_SUPPLY') {
      const clinical = input.dosageForm != null || input.route != null || input.releaseType != null;
      if (clinical) {
        throw new ValidationError(
          'A consumable is not administered, so it has no dosage form or route. Record handling notes on its storage profile instead.'
        );
      }
    }

    const existing = await tx.medicineDetail.findFirst({ where: { productId } });

    const data = {
      dosageForm: input.dosageForm ?? null,
      route: input.route ?? null,
      releaseType: input.releaseType ?? null,
      isNarrowTherapeuticIndex: input.isNarrowTherapeuticIndex,
      prescriptionClassificationHint: input.prescriptionClassificationHint ?? null,
      labelInstructions: input.labelInstructions ?? null,
      defaultCourseDays: input.defaultCourseDays ?? null,
    };

    /*
     * `findFirst` then create/update rather than `upsert`.
     *
     * The unique is (organization_id, product_id) NULLS NOT DISTINCT, and Prisma
     * refuses to build a `where` for a compound unique with a nullable
     * component. Same constraint, and the same workaround, as the settings and
     * clinical-masters seeds. See PITFALLS.
     */
    const row = existing
      ? await tx.medicineDetail.update({ where: { id: existing.id }, data })
      : await tx.medicineDetail.create({
          data: { organizationId: product.organizationId, productId, ...data },
        });

    await recordAudit(tx, ctx, {
      action: existing ? 'UPDATE' : 'CREATE',
      entityType: 'medicine_detail',
      entityId: row.id,
      ...(existing
        ? {
            before: {
              dosageForm: existing.dosageForm,
              route: existing.route,
              releaseType: existing.releaseType,
              isNarrowTherapeuticIndex: existing.isNarrowTherapeuticIndex,
            },
          }
        : {}),
      after: {
        productId,
        dosageForm: row.dosageForm,
        route: row.route,
        releaseType: row.releaseType,
        isNarrowTherapeuticIndex: row.isNarrowTherapeuticIndex,
      },
      ...options,
    });

    return toDetail(row);
  });
}
