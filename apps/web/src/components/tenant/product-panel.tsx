'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type {
  CreateProductIdentifierRequest,
  MedicineDetail,
  ProductDetail,
  ProductIdentifierType,
  ProductSummary,
  UnitSummary,
} from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { cn } from '@/lib/cn';
import {
  addIdentifierAction,
  cloneProductAction,
  expireIdentifierAction,
  replacePackagingAction,
  replaceTaxClassificationsAction,
  saveMedicineDetailAction,
  updateProductAction,
} from '@/app/(tenant)/t/[slug]/(app)/products/actions';

/**
 * One product, and the five facets hanging off it.
 *
 * ── A PLATFORM PRODUCT IS READ-ONLY, AND THE SCREEN SAYS SO ONCE ─────────────
 * Rather than disabling thirty controls and leaving the user to work out why,
 * the panel shows one banner explaining that this is a shared catalogue entry
 * and offering the action that actually helps: copy it. The database is what
 * enforces this — a tenant row cannot reference a platform product through the
 * composite foreign key — so the UI is explaining a rule, not implementing one.
 *
 * ── FOUR DIFFERENT PERMISSIONS DECIDE WHAT IS EDITABLE HERE ──────────────────
 * The catalogue fields, the identifiers, the tax classification and the medicine
 * detail are four separate decisions belonging to four different jobs. A control
 * the caller cannot use is not rendered — following it would only produce a 403
 * from the API, and a screen full of doors that do not open is worse than a
 * short one. The API is still the control; this is the courtesy.
 *
 * ⚠️ EQUIVALENTS ARE LABELLED "SAME COMPOSITION", NEVER "CAN BE SUBSTITUTED".
 *   Whether one may be dispensed in place of another is a regulatory question
 *   that depends on jurisdiction, on the prescriber's instruction and on whether
 *   the drug has a narrow therapeutic index. That engine lands in PI-5. Labelling
 *   this list as permission would put a clinical claim on screen that nothing in
 *   the system has checked.
 */

type Tab = 'details' | 'packaging' | 'identifiers' | 'tax' | 'medicine' | 'equivalents';

const IDENTIFIER_TYPES = [
  { value: 'GTIN', label: 'GTIN' },
  { value: 'EAN', label: 'EAN' },
  { value: 'UPC', label: 'UPC' },
  { value: 'NDC', label: 'NDC' },
  { value: 'NATIONAL_CODE', label: 'National code' },
  { value: 'MANUFACTURER_CODE', label: 'Manufacturer code' },
  { value: 'INTERNAL_SKU', label: 'Our SKU' },
  { value: 'LOCAL_REGULATORY', label: 'Regulatory number' },
];

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DISCONTINUED', label: 'Discontinued' },
  { value: 'WITHDRAWN', label: 'Withdrawn' },
];

const DOSAGE_FORMS = [
  '',
  'TABLET',
  'CAPSULE',
  'SYRUP',
  'SUSPENSION',
  'SOLUTION',
  'INJECTION',
  'INFUSION',
  'CREAM',
  'OINTMENT',
  'GEL',
  'LOTION',
  'DROPS',
  'SPRAY',
  'INHALER',
  'PATCH',
  'SUPPOSITORY',
  'PESSARY',
  'POWDER',
  'GRANULES',
  'LOZENGE',
  'IMPLANT',
  'OTHER',
];

const ROUTES = [
  '',
  'ORAL',
  'SUBLINGUAL',
  'BUCCAL',
  'INTRAVENOUS',
  'INTRAMUSCULAR',
  'SUBCUTANEOUS',
  'INTRADERMAL',
  'TOPICAL',
  'TRANSDERMAL',
  'INHALATION',
  'NASAL',
  'OPHTHALMIC',
  'OTIC',
  'RECTAL',
  'VAGINAL',
  'INTRATHECAL',
  'INTRA_ARTICULAR',
  'OTHER',
];

/** `MODIFIED_RELEASE` reads badly in a menu; sentence case with the underscore
 *  removed is what a pharmacist calls it. */
function humanise(value: string): string {
  if (value === '') return 'Not recorded';
  const lower = value.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const asOptions = (values: string[]) => values.map((v) => ({ value: v, label: humanise(v) }));

interface Props {
  slug: string;
  product: ProductDetail;
  equivalents: ProductSummary[];
  medicine: MedicineDetail | null;
  units: UnitSummary[];
  canManage: boolean;
  canManageIdentifiers: boolean;
  canManageTax: boolean;
  canReadMedicine: boolean;
  canManageMedicine: boolean;
}

export function ProductPanel({
  slug,
  product,
  equivalents,
  medicine,
  units,
  canManage,
  canManageIdentifiers,
  canManageTax,
  canReadMedicine,
  canManageMedicine,
}: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('details');
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // A platform row is editable by nobody, whatever permissions the caller holds.
  const editable = canManage && product.isOwn;

  const run = (fn: () => Promise<{ status: string; message?: string }>, done: string) => {
    startTransition(async () => {
      const result = await fn();
      if (result.status === 'saved') {
        setNotice({ tone: 'success', text: done });
        router.refresh();
      } else {
        setNotice({ tone: 'error', text: result.message ?? 'That could not be saved.' });
      }
    });
  };

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'details', label: 'Details', show: true },
    { id: 'packaging', label: 'Packaging', show: true },
    { id: 'identifiers', label: 'Barcodes', show: true },
    { id: 'tax', label: 'Tax', show: true },
    { id: 'medicine', label: 'Medicine', show: canReadMedicine },
    { id: 'equivalents', label: 'Same composition', show: product.compositionId !== null },
  ];

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <Link href="/products" className="text-muted hover:text-drape text-[0.8125rem]">
          ← Catalogue
        </Link>
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            {product.name}
          </h1>
          <span className="font-mono text-muted text-[0.8125rem]">{product.code}</span>
          <span
            className={
              product.isOwn
                ? 'text-drape border-drape/30 rounded-xs border px-1.5 py-0.5 text-[0.6875rem]'
                : 'text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]'
            }
          >
            {product.isOwn ? 'Yours' : 'Platform'}
          </span>
        </div>
        <p className="text-muted text-[0.875rem]">
          {humanise(product.type)} · counted in {product.baseUnitCode} ·{' '}
          {STATUSES.find((s) => s.value === product.status)?.label ?? product.status}
        </p>
      </header>

      {!product.isOwn ? (
        <Alert tone="info">
          This is a platform catalogue entry, shared by every clinic, so it cannot be edited here.
          Copy it into your own catalogue to set your pack sizes, barcodes and tax details.
          {canManage ? (
            <span className="mt-3 block">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await cloneProductAction(slug, product.id);
                    if (result.status === 'saved' && result.productId) {
                      router.push(`/products/${result.productId}`);
                    } else {
                      setNotice({
                        tone: 'error',
                        text: result.message ?? 'The copy could not be made.',
                      });
                    }
                  })
                }
              >
                {pending ? 'Copying…' : 'Copy into our catalogue'}
              </Button>
            </span>
          ) : null}
        </Alert>
      ) : null}

      {/* `Alert` has two tones, and a confirmation is `info` rather than a
          third one. The component picks its ARIA role from the tone — `error`
          is assertive — so inventing a `success` tone would mean deciding how
          loudly a save announces itself, which is a decision that belongs in
          the component and not here. */}
      {notice ? (
        <Alert tone={notice.tone === 'error' ? 'error' : 'info'}>{notice.text}</Alert>
      ) : null}

      <div className="border-rule border-b">
        <nav aria-label="Product sections" className="-mb-px flex flex-wrap gap-1">
          {tabs
            .filter((t) => t.show)
            .map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={cn(
                  'rounded-t-sm px-3 py-2 text-[0.875rem] transition-colors',
                  tab === t.id
                    ? 'border-drape text-drape border-b-2 font-medium'
                    : 'text-muted hover:text-drape border-b-2 border-transparent'
                )}
              >
                {t.label}
              </button>
            ))}
        </nav>
      </div>

      {tab === 'details' ? (
        <DetailsTab
          product={product}
          editable={editable}
          pending={pending}
          onSave={(patch) =>
            run(() => updateProductAction(slug, product.id, patch), 'Product updated')
          }
        />
      ) : null}

      {tab === 'packaging' ? (
        <PackagingTab
          product={product}
          units={units}
          editable={editable}
          pending={pending}
          onSave={(levels) =>
            run(() => replacePackagingAction(slug, product.id, levels), 'Packaging updated')
          }
        />
      ) : null}

      {tab === 'identifiers' ? (
        <IdentifiersTab
          product={product}
          editable={canManageIdentifiers && product.isOwn}
          pending={pending}
          onAdd={(body) =>
            run(() => addIdentifierAction(slug, product.id, body), 'Identifier added')
          }
          onExpire={(id) =>
            run(() => expireIdentifierAction(slug, product.id, id), 'Identifier expired')
          }
        />
      ) : null}

      {tab === 'tax' ? (
        <TaxTab
          product={product}
          editable={canManageTax && product.isOwn}
          pending={pending}
          onSave={(classifications) =>
            run(
              () => replaceTaxClassificationsAction(slug, product.id, classifications),
              'Tax classification updated'
            )
          }
        />
      ) : null}

      {tab === 'medicine' && canReadMedicine ? (
        <MedicineTab
          medicine={medicine}
          editable={canManageMedicine && product.isOwn}
          pending={pending}
          onSave={(body) =>
            run(() => saveMedicineDetailAction(slug, product.id, body), 'Medicine details updated')
          }
        />
      ) : null}

      {tab === 'equivalents' ? <EquivalentsTab products={equivalents} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DetailsTab({
  product,
  editable,
  pending,
  onSave,
}: {
  product: ProductDetail;
  editable: boolean;
  pending: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(product.name);
  const [status, setStatus] = useState(product.status);
  const [brandName, setBrandName] = useState(product.brandName ?? '');
  const [genericName, setGenericName] = useState(product.genericName ?? '');

  return (
    <section className="max-w-2xl space-y-6">
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        <Fact label="Base unit" value={`${product.baseUnitCode} — cannot be changed`} />
        <Fact label="Tracking" value={humanise(product.trackingMode)} />
        <Fact label="Expiry tracked" value={product.isExpiryControlled ? 'Yes' : 'No'} />
        <Fact label="Kept in stock" value={product.isStockItem ? 'Yes' : 'No'} />
        <Fact label="Category" value={product.categoryName ?? 'Not filed'} />
        <Fact label="Manufacturer" value={product.manufacturerName ?? 'Not recorded'} />
        <Fact label="Composition" value={product.compositionName ?? 'Not a medicine'} />
        <Fact label="Storage" value={product.storageProfileName ?? 'No special requirement'} />
      </dl>

      {editable ? (
        <form
          className="border-rule space-y-4 border-t pt-6"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({
              name,
              status,
              brandName: brandName.trim() === '' ? null : brandName.trim(),
              genericName: genericName.trim() === '' ? null : genericName.trim(),
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              name="name"
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Select
              name="status"
              label="Status"
              value={status}
              options={STATUSES}
              onChange={(e) => setStatus(e.target.value as ProductDetail['status'])}
              hint="Discontinued stops reordering; existing stock still dispenses."
            />
            <Input
              name="brandName"
              label="Brand name"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
            />
            <Input
              name="genericName"
              label="Generic name"
              value={genericName}
              onChange={(e) => setGenericName(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      ) : null}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted text-[0.75rem]">{label}</dt>
      <dd className="text-ink text-[0.875rem]">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PackagingTab({
  product,
  units,
  editable,
  pending,
  onSave,
}: {
  product: ProductDetail;
  units: UnitSummary[];
  editable: boolean;
  pending: boolean;
  onSave: (levels: unknown) => void;
}) {
  const [levels, setLevels] = useState(
    product.packagings.map((p) => ({
      level: p.level,
      unitId: p.unitId,
      quantityOfChild: p.quantityOfChild,
      isDefaultPurchase: p.isDefaultPurchase,
      isDefaultSale: p.isDefaultSale,
    }))
  );

  const unitOptions = units.map((u) => ({ value: u.id, label: `${u.name} (${u.symbol})` }));

  return (
    <section className="max-w-3xl space-y-6">
      <p className="text-muted max-w-prose text-[0.875rem]">
        How this product is packed, from the single {product.baseUnitCode} upwards. Level 0 is the
        base unit itself; each level above says how many of the level below it holds — so a box of
        10 strips of 10 tablets is two rows of 10.
      </p>

      <table className="w-full text-left text-[0.875rem]">
        <thead className="text-muted border-rule border-b text-[0.75rem]">
          <tr>
            <th scope="col" className="py-2 pr-4 font-normal">
              Level
            </th>
            <th scope="col" className="py-2 pr-4 font-normal">
              Unit
            </th>
            <th scope="col" className="py-2 pr-4 font-normal">
              Holds
            </th>
            <th scope="col" className="py-2 font-normal">
              In {product.baseUnitCode}
            </th>
          </tr>
        </thead>
        <tbody className="divide-rule divide-y">
          {product.packagings.map((p) => (
            <tr key={p.id}>
              <td className="py-2 pr-4 font-mono text-[0.8125rem]">{p.level}</td>
              <td className="py-2 pr-4">{p.unitCode}</td>
              <td className="py-2 pr-4 font-mono text-[0.8125rem]">{p.quantityOfChild}</td>
              <td className="py-2 font-mono text-[0.8125rem]">{p.quantityInBase}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {editable ? (
        <div className="border-rule space-y-4 border-t pt-6">
          {levels.map((level, index) => (
            <div key={level.level} className="grid gap-3 sm:grid-cols-3">
              <Select
                name={`unit-${level.level}`}
                label={`Level ${level.level} unit`}
                value={level.unitId}
                options={unitOptions}
                disabled={level.level === 0}
                onChange={(e) =>
                  setLevels((prev) =>
                    prev.map((l, i) => (i === index ? { ...l, unitId: e.target.value } : l))
                  )
                }
                {...(level.level === 0
                  ? { hint: 'Level 0 is always the product’s base unit.' }
                  : {})}
              />
              <Input
                name={`qty-${level.level}`}
                label="Holds"
                inputMode="decimal"
                value={level.quantityOfChild}
                disabled={level.level === 0}
                onChange={(e) =>
                  setLevels((prev) =>
                    prev.map((l, i) =>
                      i === index ? { ...l, quantityOfChild: e.target.value } : l
                    )
                  )
                }
              />
              <div className="flex items-end">
                {level.level === levels.length - 1 && level.level > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setLevels((prev) => prev.slice(0, -1))}
                  >
                    Remove this level
                  </Button>
                ) : null}
              </div>
            </div>
          ))}

          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                setLevels((prev) => [
                  ...prev,
                  {
                    level: prev.length,
                    unitId: units[0]?.id ?? '',
                    quantityOfChild: '1',
                    isDefaultPurchase: false,
                    isDefaultSale: false,
                  },
                ])
              }
            >
              Add a level
            </Button>
            <Button type="button" disabled={pending} onClick={() => onSave(levels)}>
              {pending ? 'Saving…' : 'Save packaging'}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

function IdentifiersTab({
  product,
  editable,
  pending,
  onAdd,
  onExpire,
}: {
  product: ProductDetail;
  editable: boolean;
  pending: boolean;
  onAdd: (body: CreateProductIdentifierRequest) => void;
  onExpire: (identifierId: string) => void;
}) {
  const [type, setType] = useState<ProductIdentifierType>('GTIN');
  const [value, setValue] = useState('');

  return (
    <section className="max-w-3xl space-y-6">
      <p className="text-muted max-w-prose text-[0.875rem]">
        Barcodes and codes that identify this product. A scan resolves through these.
      </p>

      {product.identifiers.length === 0 ? (
        <p className="text-muted text-[0.875rem]">No identifiers recorded.</p>
      ) : (
        <ul className="border-rule divide-rule divide-y rounded-md border">
          {product.identifiers.map((identifier) => (
            <li key={identifier.id} className="flex items-center gap-3 px-4 py-3">
              <span className="text-muted w-36 shrink-0 text-[0.8125rem]">
                {IDENTIFIER_TYPES.find((t) => t.value === identifier.type)?.label ??
                  identifier.type}
              </span>
              <span className="font-mono text-ink text-[0.875rem]">{identifier.value}</span>
              {identifier.countryCode ? (
                <span className="text-muted text-[0.75rem]">{identifier.countryCode}</span>
              ) : null}
              {!identifier.isCurrent ? (
                <span className="text-signal text-[0.75rem]">Expired</span>
              ) : null}
              {editable && identifier.isCurrent ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  disabled={pending}
                  onClick={() => onExpire(identifier.id)}
                >
                  Expire
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editable ? (
        <form
          className="border-rule grid gap-3 border-t pt-6 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            onAdd({ type, value: value.trim(), isPrimary: false });
            setValue('');
          }}
        >
          <Select
            name="identifierType"
            label="Kind"
            value={type}
            options={IDENTIFIER_TYPES}
            onChange={(e) => setType(e.target.value as ProductIdentifierType)}
          />
          <Input
            name="identifierValue"
            label="Code"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="font-mono"
            required
          />
          <div className="flex items-end">
            <Button type="submit" disabled={pending || value.trim() === ''}>
              Add identifier
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

function TaxTab({
  product,
  editable,
  pending,
  onSave,
}: {
  product: ProductDetail;
  editable: boolean;
  pending: boolean;
  onSave: (classifications: unknown) => void;
}) {
  const [rows, setRows] = useState(
    product.taxClassifications.map((t) => ({
      countryCode: t.countryCode,
      regionCode: t.regionCode,
      taxCategory: t.taxCategory,
      itemCode: t.itemCode,
      effectiveFrom: t.effectiveFrom,
      effectiveTo: t.effectiveTo,
    }))
  );

  return (
    <section className="max-w-3xl space-y-6">
      <p className="text-muted max-w-prose text-[0.875rem]">
        Which tax category this product falls into, per country and per date. The category is a key
        into the clinic’s rate card — the rate itself is set on the Tax screen, not here.
      </p>

      {product.taxClassifications.length === 0 ? (
        <Alert tone="info">
          This product has no tax classification, so an invoice line for it cannot be rated. Add one
          before it is sold.
        </Alert>
      ) : (
        <table className="w-full text-left text-[0.875rem]">
          <thead className="text-muted border-rule border-b text-[0.75rem]">
            <tr>
              <th scope="col" className="py-2 pr-4 font-normal">
                Country
              </th>
              <th scope="col" className="py-2 pr-4 font-normal">
                Region
              </th>
              <th scope="col" className="py-2 pr-4 font-normal">
                Category
              </th>
              <th scope="col" className="py-2 pr-4 font-normal">
                Printed code
              </th>
              <th scope="col" className="py-2 font-normal">
                From
              </th>
            </tr>
          </thead>
          <tbody className="divide-rule divide-y">
            {product.taxClassifications.map((t) => (
              <tr key={t.id}>
                <td className="py-2 pr-4">{t.countryCode}</td>
                <td className="py-2 pr-4">{t.regionCode ?? 'All'}</td>
                <td className="py-2 pr-4 font-mono text-[0.8125rem]">{t.taxCategory}</td>
                <td className="py-2 pr-4 font-mono text-[0.8125rem]">{t.itemCode ?? '—'}</td>
                <td className="py-2 font-mono text-[0.8125rem]">{t.effectiveFrom}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editable ? (
        <div className="border-rule space-y-4 border-t pt-6">
          {rows.map((row, index) => (
            <div key={index} className="grid gap-3 sm:grid-cols-5">
              <Input
                name={`country-${index}`}
                label="Country"
                value={row.countryCode}
                maxLength={2}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((r, i) =>
                      i === index ? { ...r, countryCode: e.target.value.toUpperCase() } : r
                    )
                  )
                }
              />
              <Input
                name={`region-${index}`}
                label="Region"
                value={row.regionCode ?? ''}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((r, i) =>
                      i === index
                        ? { ...r, regionCode: e.target.value === '' ? null : e.target.value }
                        : r
                    )
                  )
                }
              />
              <Input
                name={`category-${index}`}
                label="Tax category"
                value={row.taxCategory}
                className="font-mono"
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, taxCategory: e.target.value } : r))
                  )
                }
              />
              <Input
                name={`itemCode-${index}`}
                label="Printed code"
                value={row.itemCode ?? ''}
                className="font-mono"
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((r, i) =>
                      i === index
                        ? { ...r, itemCode: e.target.value === '' ? null : e.target.value }
                        : r
                    )
                  )
                }
              />
              <Input
                name={`from-${index}`}
                label="Effective from"
                type="date"
                value={row.effectiveFrom}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, effectiveFrom: e.target.value } : r))
                  )
                }
              />
            </div>
          ))}

          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                setRows((prev) => [
                  ...prev,
                  {
                    countryCode: '',
                    regionCode: null,
                    taxCategory: '',
                    itemCode: null,
                    effectiveFrom: new Date().toISOString().slice(0, 10),
                    effectiveTo: null,
                  },
                ])
              }
            >
              Add a classification
            </Button>
            <Button type="button" disabled={pending} onClick={() => onSave(rows)}>
              {pending ? 'Saving…' : 'Save tax classification'}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

function MedicineTab({
  medicine,
  editable,
  pending,
  onSave,
}: {
  medicine: MedicineDetail | null;
  editable: boolean;
  pending: boolean;
  onSave: (body: unknown) => void;
}) {
  const [dosageForm, setDosageForm] = useState(medicine?.dosageForm ?? '');
  const [route, setRoute] = useState(medicine?.route ?? '');
  const [nti, setNti] = useState(medicine?.isNarrowTherapeuticIndex ?? false);
  const [hint, setHint] = useState(medicine?.prescriptionClassificationHint ?? '');

  return (
    <section className="max-w-2xl space-y-6">
      {!editable ? (
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Fact label="Dosage form" value={humanise(medicine?.dosageForm ?? '')} />
          <Fact label="Route" value={humanise(medicine?.route ?? '')} />
          <Fact
            label="Narrow therapeutic index"
            value={medicine?.isNarrowTherapeuticIndex ? 'Yes' : 'No'}
          />
          <Fact
            label="Prescription note"
            value={medicine?.prescriptionClassificationHint ?? 'Not recorded'}
          />
        </dl>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({
              dosageForm: dosageForm === '' ? null : dosageForm,
              route: route === '' ? null : route,
              isNarrowTherapeuticIndex: nti,
              prescriptionClassificationHint: hint.trim() === '' ? null : hint.trim(),
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              name="dosageForm"
              label="Dosage form"
              value={dosageForm}
              options={asOptions(DOSAGE_FORMS)}
              onChange={(e) => setDosageForm(e.target.value as typeof dosageForm)}
            />
            <Select
              name="route"
              label="Route"
              value={route}
              options={asOptions(ROUTES)}
              onChange={(e) => setRoute(e.target.value as typeof route)}
            />
          </div>

          <label className="text-ink flex items-start gap-2 py-2 text-[0.875rem]">
            <input
              type="checkbox"
              checked={nti}
              onChange={(e) => setNti(e.target.checked)}
              className="mt-0.5 h-4 w-4"
              aria-describedby="nti-hint"
            />
            <span>
              Narrow therapeutic index
              <span id="nti-hint" className="text-muted mt-0.5 block text-[0.8125rem]">
                Small changes in blood concentration matter clinically. Most jurisdictions treat
                substitution differently for these.
              </span>
            </span>
          </label>

          <Input
            name="prescriptionClassificationHint"
            label="Prescription note"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            hint="What this clinic believes about prescription status. A note for staff — it does not control dispensing."
          />

          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save medicine details'}
          </Button>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function EquivalentsTab({ products }: { products: ProductSummary[] }) {
  return (
    <section className="max-w-3xl space-y-4">
      <p className="text-muted max-w-prose text-[0.875rem]">
        Products built on the same composition — the same ingredients at the same strengths.
        <strong className="text-ink font-medium">
          {' '}
          This does not mean one may be dispensed in place of another.
        </strong>{' '}
        That depends on the prescription and on local rules, and is not decided here.
      </p>

      {products.length === 0 ? (
        <p className="text-muted text-[0.875rem]">
          Nothing else in the catalogue shares this composition.
        </p>
      ) : (
        <ul className="border-rule divide-rule divide-y rounded-md border">
          {products.map((product) => (
            <li key={product.id} className="hover:bg-drape-tint/40 relative transition-colors">
              <div className="flex flex-wrap items-baseline gap-3 px-4 py-3">
                <Link
                  href={`/products/${product.id}`}
                  className="text-ink after:absolute after:inset-0 text-[0.9375rem]"
                >
                  {product.name}
                </Link>
                <span className="font-mono text-muted text-[0.75rem]">{product.code}</span>
                <span className="text-muted ml-auto text-[0.75rem]">
                  {product.manufacturerName ?? '—'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
