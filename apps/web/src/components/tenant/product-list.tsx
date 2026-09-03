'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState, useTransition } from 'react';
import type { ManufacturerSummary, ProductCategory, ProductSummary } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';

/**
 * The catalogue: what this clinic stocks, and what the platform offers.
 *
 * ⚠️ THE FILTERS DRIVE THE URL, AND THE URL DRIVES THE FETCH. Nothing on this
 *   screen filters an in-memory array. The rows are one server-rendered page of
 *   a query the API ran in SQL, so changing a filter is a navigation. That is
 *   what keeps the screen usable on a catalogue of forty thousand rows, and it
 *   is why there is a `useTransition` here rather than a spinner: the current
 *   page stays legible and dims while the next one is fetched.
 *
 * ── PROVENANCE IS THE ONE THING THIS SCREEN EMPHASISES ───────────────────────
 * Every row is either the platform's or this clinic's, and the difference is not
 * cosmetic: a platform row cannot be edited at all. A clinic customises one by
 * copying it, and the database enforces that — a tenant's packaging or
 * identifier physically cannot attach to a shared product. So the list says
 * which is which on every row, in a word, before anyone clicks into a product
 * and finds the fields disabled.
 *
 * ⚠️ CARRIED BY A WORD, NEVER BY COLOUR ALONE (WCAG 1.4.1, and AGENTS.md lists
 *   this as a rule already got wrong once on this codebase).
 *
 * ⚠️ THE ROW IS ONE STRETCHED `<Link>`, the same shape as the roster and the day
 *   board — a real anchor keeps focus, middle-click, copy-link and the keyboard,
 *   none of which an `onClick` on a `<div>` has.
 */

const TYPES = [
  { value: '', label: 'Any kind' },
  { value: 'MEDICINE', label: 'Medicine' },
  { value: 'VACCINE', label: 'Vaccine' },
  { value: 'CONSUMABLE', label: 'Consumable' },
  { value: 'SURGICAL_SUPPLY', label: 'Surgical supply' },
  { value: 'MEDICAL_DEVICE', label: 'Medical device' },
  { value: 'IMPLANT', label: 'Implant' },
  { value: 'DENTAL_MATERIAL', label: 'Dental material' },
  { value: 'LAB_REAGENT', label: 'Lab reagent' },
  { value: 'DIAGNOSTIC_KIT', label: 'Diagnostic kit' },
  { value: 'VETERINARY_MEDICINE', label: 'Veterinary medicine' },
  { value: 'VETERINARY_CONSUMABLE', label: 'Veterinary consumable' },
  { value: 'GENERAL_CLINICAL_SUPPLY', label: 'General clinical supply' },
];

const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DISCONTINUED', label: 'Discontinued' },
  { value: 'WITHDRAWN', label: 'Withdrawn' },
];

const SOURCES = [
  { value: 'ALL', label: 'Everything' },
  { value: 'OWN', label: 'Added by us' },
  { value: 'PLATFORM', label: 'Platform catalogue' },
];

/** Human labels for the type enum, so a row never shows SCREAMING_SNAKE. */
const TYPE_LABEL = new Map(TYPES.map((t) => [t.value, t.label]));

/*
 * No `slug`. This component builds only RELATIVE links and pushes only relative
 * paths — `proxy.ts` puts the tenant back from the Host header — so it never had
 * a use for one. It was accepted and immediately discarded as `slug: _slug`,
 * which reads like a deliberate omission rather than an unused prop and would
 * have invited the next person to start using it. A tenant link that carries
 * `/t/<slug>` 404s.
 */
interface Props {
  products: ProductSummary[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  categories: ProductCategory[];
  manufacturers: ManufacturerSummary[];
  canManage: boolean;
}

export function ProductList({ products, meta, categories, manufacturers, canManage }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const current = useMemo(
    () => ({
      q: searchParams.get('q') ?? '',
      type: searchParams.get('type') ?? '',
      status: searchParams.get('status') ?? '',
      categoryId: searchParams.get('categoryId') ?? '',
      manufacturerId: searchParams.get('manufacturerId') ?? '',
      source: searchParams.get('source') ?? 'ALL',
    }),
    [searchParams]
  );

  const [term, setTerm] = useState(current.q);

  /**
   * Write one filter into the URL.
   *
   * ⚠️ ALWAYS RESETS TO PAGE 1. Changing a filter while on page 7 of the old
   *   result set lands on page 7 of a set that may have two pages, and the
   *   screen shows an empty table for a filter that matched plenty.
   */
  const setFilter = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === '' || value === 'ALL') next.delete(key);
        else next.set(key, value);
      }
      next.delete('page');
      startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [pathname, router, searchParams]
  );

  const goToPage = useCallback(
    (page: number) => {
      const next = new URLSearchParams(searchParams.toString());
      if (page <= 1) next.delete('page');
      else next.set('page', String(page));
      startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [pathname, router, searchParams]
  );

  const categoryOptions = useMemo(
    () => [
      { value: '', label: 'Any category' },
      ...categories.map((c) => ({
        value: c.id,
        // Indented by depth so the tree's shape survives a flat <select>. An
        // en-space rather than a hyphen: a screen reader announces the label,
        // and "dash dash Antibiotics" is not what the option is called.
        label: `${' '.repeat(c.depth)}${c.name}`,
      })),
    ],
    [categories]
  );

  const manufacturerOptions = useMemo(
    () => [
      { value: '', label: 'Any manufacturer' },
      ...manufacturers.map((m) => ({ value: m.id, label: m.name })),
    ],
    [manufacturers]
  );

  const from = meta.total === 0 ? 0 : (meta.page - 1) * meta.limit + 1;
  const to = Math.min(meta.page * meta.limit, meta.total);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Catalogue
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            Everything this clinic stocks — medicines, consumables, materials and devices.
          </p>
        </div>
        {/* An anchor, not a Button — this navigates. `Button` renders a real
            <button>, and wrapping a Link in one produces a nested interactive
            element that keyboard users cannot reach predictably. The classes are
            the `primary` variant's, the same way login-form and signup-form
            already spell them out for their own anchors. */}
        {canManage ? (
          <div className="flex flex-wrap gap-3">
            {/* Secondary, because a clinic adds one product often and imports a
                catalogue once — but it has to be FINDABLE from here, or the
                answer to "I have four hundred medicines" is four hundred trips
                through the form beside it. */}
            <Link
              href="/products/import"
              className="border-rule text-ink hover:bg-drape-tint/40 inline-flex items-center justify-center rounded-md border px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
            >
              Import a catalogue
            </Link>
            <Link
              href="/products/new"
              className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
            >
              Add a product
            </Link>
          </div>
        ) : null}
      </header>

      {/* Filters. A form so Enter submits the search from the keyboard. */}
      <form
        className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-6"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter({ q: term.trim() });
        }}
      >
        <div className="sm:col-span-2">
          <Input
            label="Search"
            name="q"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Name, code, brand or barcode"
            hint="At least two characters."
          />
        </div>
        <Select
          label="Kind"
          name="type"
          value={current.type}
          options={TYPES}
          onChange={(event) => setFilter({ type: event.target.value })}
        />
        <Select
          label="Status"
          name="status"
          value={current.status}
          options={STATUSES}
          onChange={(event) => setFilter({ status: event.target.value })}
        />
        <Select
          label="Category"
          name="categoryId"
          value={current.categoryId}
          options={categoryOptions}
          onChange={(event) => setFilter({ categoryId: event.target.value })}
        />
        <Select
          label="Source"
          name="source"
          value={current.source}
          options={SOURCES}
          onChange={(event) => setFilter({ source: event.target.value })}
        />
        <div className="lg:col-span-2">
          <Select
            label="Manufacturer"
            name="manufacturerId"
            value={current.manufacturerId}
            options={manufacturerOptions}
            onChange={(event) => setFilter({ manufacturerId: event.target.value })}
          />
        </div>
        <div className="flex items-end">
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </div>
      </form>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {meta.total === 0
            ? 'No products match these filters.'
            : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {products.length === 0 ? (
          /*
           * An empty screen is an invitation to act, not a shrug. Two different
           * empty states, because they need two different next steps: a clinic
           * with no catalogue at all needs to add something, while a filter that
           * matched nothing needs the filter loosened.
           */
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">
              {meta.total === 0 && searchParams.size === 0
                ? 'Your catalogue is empty.'
                : 'Nothing matches these filters.'}
            </p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              {meta.total === 0 && searchParams.size === 0
                ? 'Add the products you stock, or copy them from the platform catalogue.'
                : 'Try a broader search, or clear a filter.'}
            </p>
          </div>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {products.map((product) => (
              <li key={product.id} className="hover:bg-drape-tint/40 relative transition-colors">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
                  <Link
                    href={`/products/${product.id}`}
                    /* The stretched anchor. `after:` covers the row, so the
                       whole thing is clickable while the link text is what a
                       screen reader announces. */
                    className="text-ink after:absolute after:inset-0 text-[0.9375rem] font-medium"
                  >
                    {product.name}
                  </Link>

                  <span className="font-mono text-muted text-[0.75rem]">{product.code}</span>

                  <span className="text-muted text-[0.75rem]">
                    {TYPE_LABEL.get(product.type) ?? product.type}
                  </span>

                  {/* Provenance. A word, not a colour — see the header. */}
                  <span
                    className={
                      product.isOwn
                        ? 'text-drape border-drape/30 rounded-xs border px-1.5 py-0.5 text-[0.6875rem]'
                        : 'text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]'
                    }
                  >
                    {product.isOwn ? 'Yours' : 'Platform'}
                  </span>

                  {product.status !== 'ACTIVE' ? (
                    <span className="text-signal text-[0.75rem]">
                      {STATUSES.find((s) => s.value === product.status)?.label ?? product.status}
                    </span>
                  ) : null}

                  <span className="text-muted ml-auto text-[0.75rem]">
                    {product.manufacturerName ?? product.categoryName ?? '—'}
                    <span className="sr-only">
                      {product.manufacturerName
                        ? ' manufacturer'
                        : product.categoryName
                          ? ' category'
                          : ' no manufacturer or category recorded'}
                    </span>
                  </span>

                  <span className="font-mono text-muted text-[0.75rem]">
                    {product.baseUnitSymbol}
                    <span className="sr-only"> base unit</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {meta.totalPages > 1 ? (
          <nav
            aria-label="Catalogue pages"
            className="mt-4 flex items-center justify-between gap-4"
          >
            <Button
              type="button"
              variant="secondary"
              disabled={meta.page <= 1}
              onClick={() => goToPage(meta.page - 1)}
            >
              Previous
            </Button>
            <p className="text-muted text-[0.8125rem]">
              Page {meta.page} of {meta.totalPages}
            </p>
            <Button
              type="button"
              variant="secondary"
              disabled={meta.page >= meta.totalPages}
              onClick={() => goToPage(meta.page + 1)}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
