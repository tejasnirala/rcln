import Link from 'next/link';
import type { InventoryLocationListResponse } from '@rcln/contracts';
import { StockNav } from '@/components/tenant/stock-nav';

/**
 * Where this clinic keeps things.
 *
 * ⚠️ A BRANCH HAS MANY LOCATIONS, AND THIS SCREEN EXISTS TO MAKE THAT OBVIOUS.
 *   A clinic has a main pharmacy, a vaccine fridge, a controlled cabinet and a
 *   trolley in each procedure room; folding them into "the branch's stock" makes
 *   cold chain, controlled-substance reconciliation and departmental consumption
 *   inexpressible at once, and it cannot be undone without a migration under live
 *   stock (PI-ADR-012).
 *
 * ⚠️ `kind` IS METADATA, NEVER AUTHORIZATION. A cabinet marked "controlled" is
 *   where a clinic chose to put one, not a statement that anyone is barred from
 *   it. The screen says what a place IS and what it REQUIRES; it grants nothing.
 *
 * Grouped by branch, because a location belongs to one site and an org-wide
 * administrator sees several. A flat list would put two fridges called FRIDGE-1
 * next to each other with nothing to tell them apart.
 *
 * NO PHI.
 */
const KIND_LABEL: Record<string, string> = {
  MAIN_PHARMACY: 'Main pharmacy',
  SATELLITE_PHARMACY: 'Satellite pharmacy',
  REFRIGERATOR: 'Refrigerator',
  FREEZER: 'Freezer',
  CONTROLLED_CABINET: 'Controlled cabinet',
  DEPARTMENT_STORE: 'Department store',
  PROCEDURE_ROOM: 'Procedure room',
  LAB_STORE: 'Lab store',
  DENTAL_STORE: 'Dental store',
  VETERINARY_STORE: 'Veterinary store',
  CENTRAL_WAREHOUSE: 'Central warehouse',
  CONSIGNMENT: 'Consignment',
  DISPOSAL: 'Disposal',
};

export function LocationList({
  locations,
  canManage,
}: {
  locations: InventoryLocationListResponse['locations'];
  canManage: boolean;
}) {
  const byBranch = new Map<string, { name: string; rows: typeof locations }>();
  for (const location of locations) {
    const existing = byBranch.get(location.branchId);
    if (existing) existing.rows.push(location);
    else byBranch.set(location.branchId, { name: location.branchName, rows: [location] });
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Locations
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            Every place stock is kept, and what each one is for.
          </p>
        </div>
        {/* An anchor, not a Button — this navigates. `Button` renders a real
            <button>, and wrapping a Link in one produces a nested interactive
            element keyboard users cannot reach predictably. The classes are the
            `primary` variant's, as the catalogue's own header already spells
            them out. */}
        {canManage ? (
          <Link
            href="/stock/locations/new"
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Add a location
          </Link>
        ) : null}
      </header>

      <StockNav />

      {locations.length === 0 ? (
        <div className="border-rule bg-card rounded-md border p-10 text-center">
          <p className="text-ink text-[0.9375rem]">No locations have been set up.</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
            {canManage
              ? 'Add the main pharmacy first, then the fridge, the controlled cabinet and any departmental stores. Stock is counted per location, so it is worth naming them the way your staff already do.'
              : 'Ask an administrator at this clinic to add the places you keep stock.'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {[...byBranch.entries()].map(([branchId, group]) => (
            <section key={branchId} className="border-rule bg-card rounded-md border">
              <h2 className="border-rule text-ink border-b px-4 py-2.5 text-[0.875rem] font-medium">
                {group.name}
              </h2>
              <ul className="divide-rule divide-y">
                {group.rows.map((location) => (
                  <li
                    key={location.id}
                    className={
                      canManage ? 'hover:bg-drape-tint/40 relative transition-colors' : undefined
                    }
                  >
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
                      {/* The stretched anchor, the same shape the catalogue rows
                        use: `after:` covers the row so the whole thing is
                        clickable, while the link text is what a screen reader
                        announces. Only for callers who can actually edit — a row
                        that navigates to a refusal is worse than a row that does
                        not navigate. */}
                      {canManage ? (
                        <Link
                          href={`/stock/locations/${location.id}`}
                          className="text-ink after:absolute after:inset-0 text-[0.9375rem]"
                        >
                          {location.name}
                        </Link>
                      ) : (
                        <span className="text-ink text-[0.9375rem]">{location.name}</span>
                      )}
                      <span className="font-mono text-muted text-[0.75rem]">{location.code}</span>
                      <span className="text-muted text-[0.75rem]">
                        {KIND_LABEL[location.kind] ?? location.kind}
                      </span>

                      {/* Words, not colour — the same rule the catalogue follows. */}
                      {location.isDispensingPoint ? (
                        <span className="text-drape border-drape/30 rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                          Dispenses
                        </span>
                      ) : null}
                      {location.requiresControlledAccess ? (
                        <span className="text-signal border-signal/30 rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                          Controlled access
                        </span>
                      ) : null}
                      {!location.isActive ? (
                        <span className="text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                          Not in use
                        </span>
                      ) : null}

                      <span className="text-muted ml-auto text-[0.75rem]">
                        {location.storageProfileName ?? 'no storage requirement'}
                        {location.areaCount > 0
                          ? ` · ${location.areaCount} ${location.areaCount === 1 ? 'area' : 'areas'}`
                          : ''}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="text-muted text-[0.8125rem]">
        Stock is counted per location.{' '}
        <Link href="/stock" className="text-drape underline underline-offset-4">
          See what is on each shelf
        </Link>
      </p>
    </div>
  );
}
