'use client';

import { useId, useMemo, useState } from 'react';
import type { SpecialtyProficiency, SpecialtySummary } from '@rcln/contracts';
import { Button } from '@/components/ui/button';
import { Input, Select, type SelectOption } from '@/components/ui/field';
import { ancestorLabel, buildTree, childrenOf, columnLabel, searchNodes } from '@/lib/taxonomy';

/**
 * Choosing what a doctor is trained in.
 *
 * Replaces a single flat `<select>` of all ~150 nodes, which asked the user to
 * find "Structural Heart Disease" in an alphabetical list with no indication
 * that it sits under Cardiology, and allowed exactly one choice.
 *
 * ── THE SIGNATURE: A CLASSIFICATION IS A PATH, NOT A LABEL ───────────────────
 * Every selected entry renders its ancestry above its name —
 * `Medical › Cardiology › Interventional Cardiology` over "Structural Heart
 * Disease". That is the one idea the whole feature exists to express, and the
 * flat select could not express it at all: two nodes named "Sports Medicine"
 * and "Sports Rehabilitation" are only distinguishable by where they hang.
 * Everything else here is deliberately quiet — this is a data-entry screen, and
 * `apps/web/AGENTS.md` is explicit that boldness belongs in the shell, not here.
 *
 * ── NO NEW DESIGN TOKENS ─────────────────────────────────────────────────────
 * Palette, type and radii are the ones `globals.css` already defines. A second
 * visual direction inside the app would be a bug, not a fresh design.
 *
 * ── THE BROWSER IS CASCADING COLUMNS, LABELLED FROM THE DATA ─────────────────
 * ⚠️ Column headings come from the `type` of the nodes actually in them, never
 *   from their position. Dental reaches a specialty in two hops and Cardiology
 *   takes four; a third column hardcoded to "Sub-specialty" would be wrong for
 *   half the tree. See `columnLabel`.
 */

/** One row's editable detail. Everything but the id is optional. */
export interface ClassificationEntry {
  specialtyId: string;
  isPrimary: boolean;
  proficiency: SpecialtyProficiency | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

const PROFICIENCIES: SelectOption[] = [
  { value: '', label: 'Not recorded' },
  { value: 'PRACTISING', label: 'Practising' },
  { value: 'SPECIALIST', label: 'Specialist' },
  { value: 'EXPERT', label: 'Expert' },
];

export interface ClassificationPickerProps {
  /** Every node this clinic can see, flat. Already on the page. */
  specialties: SpecialtySummary[];
  /** Initial selection, in display order. */
  defaultValue?: Partial<ClassificationEntry>[];
  label?: string;
  hint?: string;
}

export function ClassificationPicker({
  specialties,
  defaultValue = [],
  label = 'Clinical classification',
  hint = 'What this doctor is trained in. Add as many as apply and mark one as their main one.',
}: ClassificationPickerProps) {
  const tree = useMemo(() => buildTree(specialties), [specialties]);

  const [entries, setEntries] = useState<ClassificationEntry[]>(() =>
    defaultValue
      .filter((d): d is Partial<ClassificationEntry> & { specialtyId: string } =>
        Boolean(d.specialtyId)
      )
      .map((d) => ({
        specialtyId: d.specialtyId,
        isPrimary: d.isPrimary ?? false,
        proficiency: d.proficiency ?? null,
        effectiveFrom: d.effectiveFrom ?? null,
        effectiveTo: d.effectiveTo ?? null,
      }))
  );
  const [browsing, setBrowsing] = useState(false);
  /** Which rows have their detail fields revealed. Ids, not indexes. */
  const [expanded, setExpanded] = useState<string[]>([]);

  const headingId = useId();
  const hintId = useId();

  const selected = useMemo(() => entries.map((e) => e.specialtyId), [entries]);

  const add = (id: string): void => {
    setEntries((prev) =>
      prev.some((e) => e.specialtyId === id)
        ? prev
        : [
            ...prev,
            {
              specialtyId: id,
              // First choice becomes the main one. Making the user pick a main
              // specialty separately, having just chosen exactly one, is a
              // question with one answer.
              isPrimary: prev.length === 0,
              proficiency: null,
              effectiveFrom: null,
              effectiveTo: null,
            },
          ]
    );
    setBrowsing(false);
  };

  const remove = (id: string): void => {
    setEntries((prev) => {
      const kept = prev.filter((e) => e.specialtyId !== id);
      // Removing the main one promotes the first survivor rather than leaving
      // the profile with no headline specialty.
      if (kept.length > 0 && !kept.some((e) => e.isPrimary)) {
        return kept.map((e, i) => (i === 0 ? { ...e, isPrimary: true } : e));
      }
      return kept;
    });
    setExpanded((prev) => prev.filter((x) => x !== id));
  };

  const makePrimary = (id: string): void => {
    setEntries((prev) => prev.map((e) => ({ ...e, isPrimary: e.specialtyId === id })));
  };

  const patch = (id: string, change: Partial<ClassificationEntry>): void => {
    setEntries((prev) => prev.map((e) => (e.specialtyId === id ? { ...e, ...change } : e)));
  };

  return (
    <fieldset className="grid gap-3" aria-describedby={hintId}>
      <legend className="text-ink text-[0.8125rem] font-medium" id={headingId}>
        {label}
      </legend>
      <p className="text-muted -mt-1 text-[0.8125rem] leading-relaxed" id={hintId}>
        {hint}
      </p>

      {/*
        The form payload, as ONE JSON field rather than a set of indexed inputs.

        Each row now carries proficiency and two dates, so the flat-input
        alternative is `classifications[0][effectiveFrom]`-style names that have
        to be parsed back into an array by hand — a scheme where removing the
        middle row silently renumbers the rest. One JSON blob keeps the array
        shape the contract already defines, and the server re-validates it with
        the same Zod schema either way, so nothing is trusted for being
        well-formed.

        ⚠️ THE SENTINEL IS LOAD-BEARING. With an empty selection this component
          renders an empty array, which after JSON round-tripping is
          indistinguishable from a form that never contained a picker unless
          something marks the picker's presence. The first means "remove every
          classification" and the second means "leave them alone"; without the
          sentinel, clearing the last classification would silently do nothing.
      */}
      <input type="hidden" name="classificationsPresent" value="1" />
      <input type="hidden" name="classifications" value={JSON.stringify(entries)} />

      {entries.length === 0 ? (
        <p className="border-rule text-muted rounded-[var(--radius-md)] border border-dashed px-3 py-4 text-[0.8125rem]">
          Nothing recorded yet.
        </p>
      ) : (
        <ul className="grid gap-2">
          {entries.map((entry) => {
            const id = entry.specialtyId;
            const node = tree.byId.get(id);
            const ancestry = ancestorLabel(tree, id);
            const isOpen = expanded.includes(id);

            return (
              <li
                key={id}
                className="border-rule bg-card rounded-[var(--radius-md)] border px-3 py-2.5"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    {ancestry ? (
                      <p className="text-muted font-mono text-[0.6875rem] tracking-tight">
                        {ancestry}
                      </p>
                    ) : null}
                    <p className="text-ink text-[0.875rem] font-medium">
                      {node?.name ?? 'No longer in the catalogue'}
                      {entry.isPrimary ? (
                        <span className="bg-drape-tint text-drape-deep ml-2 rounded-[var(--radius-xs)] px-1.5 py-0.5 align-middle text-[0.6875rem] font-medium">
                          Main
                        </span>
                      ) : null}
                    </p>
                    <ClassificationSummary entry={entry} />
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {!entry.isPrimary ? (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => makePrimary(id)}
                        className="min-h-[24px] px-2 py-1 text-[0.75rem]"
                      >
                        Make main
                        <span className="sr-only"> specialty: {node?.name}</span>
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      aria-expanded={isOpen}
                      onClick={() =>
                        setExpanded((prev) =>
                          prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                        )
                      }
                      className="min-h-[24px] px-2 py-1 text-[0.75rem]"
                    >
                      {isOpen ? 'Hide detail' : 'Add detail'}
                      <span className="sr-only"> for {node?.name}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => remove(id)}
                      className="min-h-[24px] px-2 py-1 text-[0.75rem]"
                    >
                      Remove
                      <span className="sr-only"> {node?.name}</span>
                    </Button>
                  </div>
                </div>

                {/*
                  Behind a disclosure, not inline. Three more controls on every
                  row would triple the height of the one thing this screen exists
                  to do, and all three are genuinely optional — most clinics
                  record a specialty and nothing else.
                */}
                {isOpen ? (
                  <div className="border-rule mt-3 grid gap-3 border-t pt-3 sm:grid-cols-3">
                    <Select
                      name={`proficiency-${id}`}
                      label="Depth"
                      value={entry.proficiency ?? ''}
                      onChange={(e) =>
                        patch(id, {
                          proficiency: (e.target.value || null) as SpecialtyProficiency | null,
                        })
                      }
                      options={PROFICIENCIES}
                      hint="Shown in the directory."
                    />
                    <Input
                      name={`effectiveFrom-${id}`}
                      label="Practising since"
                      type="date"
                      value={entry.effectiveFrom ?? ''}
                      onChange={(e) => patch(id, { effectiveFrom: e.target.value || null })}
                    />
                    <Input
                      name={`effectiveTo-${id}`}
                      label="Until"
                      type="date"
                      value={entry.effectiveTo ?? ''}
                      onChange={(e) => patch(id, { effectiveTo: e.target.value || null })}
                      hint="Leave blank if current."
                      {...(entry.effectiveFrom ? { min: entry.effectiveFrom } : {})}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {browsing ? (
        <Browser
          tree={tree}
          alreadyChosen={selected}
          onChoose={add}
          onCancel={() => setBrowsing(false)}
        />
      ) : (
        <div>
          <Button type="button" variant="secondary" onClick={() => setBrowsing(true)}>
            Add a classification
          </Button>
        </div>
      )}
    </fieldset>
  );
}

/**
 * The detail a row carries, when it carries any — so the disclosure does not
 * have to be opened to see that something is recorded behind it.
 *
 * Dates are printed as given (`YYYY-MM-DD`). No locale formatting: these are
 * calendar facts about a career, not timestamps, and reformatting them in the
 * browser's locale would make a shared screenshot ambiguous between clinics.
 */
function ClassificationSummary({ entry }: { entry: ClassificationEntry }): React.ReactNode {
  const parts = [
    entry.proficiency
      ? (PROFICIENCIES.find((p) => p.value === entry.proficiency)?.label ?? entry.proficiency)
      : null,
    entry.effectiveFrom ? `since ${entry.effectiveFrom}` : null,
    entry.effectiveTo ? `until ${entry.effectiveTo}` : null,
  ].filter(Boolean);

  if (parts.length === 0) return null;
  return <p className="text-muted mt-0.5 text-[0.75rem]">{parts.join(' · ')}</p>;
}

/**
 * Drill down a column at a time, or search across the whole tree.
 *
 * Both routes exist because they answer different questions. Someone who knows
 * they want "Endodontics" types it; someone browsing what a clinic can offer
 * needs to see that Dental has eleven specialties under it. A search-only
 * control hides the shape of the taxonomy, and a browse-only one makes finding
 * one known leaf a four-click expedition.
 */
function Browser({
  tree,
  alreadyChosen,
  onChoose,
  onCancel,
}: {
  tree: ReturnType<typeof buildTree>;
  alreadyChosen: string[];
  onChoose: (id: string) => void;
  onCancel: () => void;
}) {
  /** Ids of the nodes opened so far. `trail[0]` is the chosen root. */
  const [trail, setTrail] = useState<string[]>([]);
  const [term, setTerm] = useState('');
  const searchId = useId();

  const results = useMemo(() => searchNodes(tree, term), [tree, term]);
  const searching = term.trim().length >= 2;

  /*
   * One column per opened level, plus the roots. Derived from `trail` rather
   * than stored, so the two cannot drift when the user steps back.
   */
  const columns = useMemo(() => {
    const out = [childrenOf(tree, null)];
    for (const id of trail) {
      const kids = childrenOf(tree, id);
      if (kids.length === 0) break;
      out.push(kids);
    }
    return out;
  }, [tree, trail]);

  const openAt = (depth: number, id: string): void => {
    setTrail((prev) => [...prev.slice(0, depth), id]);
  };

  return (
    <div className="border-rule bg-paper grid gap-3 rounded-[var(--radius-md)] border p-3">
      <div className="grid gap-1">
        <label className="text-ink text-[0.8125rem] font-medium" htmlFor={searchId}>
          Find a classification
        </label>
        <input
          id={searchId}
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search, or browse below"
          className="border-rule bg-card text-ink placeholder:text-muted focus-visible:outline-focus-ring min-h-[2.25rem] rounded-[var(--radius-sm)] border px-3 text-[0.875rem] focus-visible:outline-2 focus-visible:outline-offset-2"
        />
      </div>

      {searching ? (
        results.length === 0 ? (
          <p className="text-muted text-[0.8125rem]">
            Nothing matches “{term.trim()}”. Try a shorter word, or browse the list.
          </p>
        ) : (
          <ul className="max-h-64 overflow-y-auto">
            {results.map((node) => {
              const chosen = alreadyChosen.includes(node.id);
              const ancestry = ancestorLabel(tree, node.id);
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    disabled={chosen}
                    onClick={() => onChoose(node.id)}
                    className="hover:bg-drape-tint focus-visible:outline-focus-ring block w-full rounded-[var(--radius-sm)] px-2 py-1.5 text-left disabled:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-2"
                  >
                    {ancestry ? (
                      <span className="text-muted block font-mono text-[0.6875rem]">
                        {ancestry}
                      </span>
                    ) : null}
                    <span className="text-ink text-[0.875rem]">{node.name}</span>
                    {chosen ? (
                      <span className="text-muted ml-2 text-[0.75rem]">Already added</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <div className="flex gap-2 overflow-x-auto">
          {columns.map((nodes, depth) => (
            <Column
              // Columns are positional; the trail id above them is what makes
              // one column distinct from the next at the same depth.
              key={trail[depth - 1] ?? 'roots'}
              nodes={nodes}
              openId={trail[depth] ?? null}
              alreadyChosen={alreadyChosen}
              tree={tree}
              onOpen={(id) => openAt(depth, id)}
              onChoose={onChoose}
            />
          ))}
        </div>
      )}

      <div>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Column({
  nodes,
  openId,
  alreadyChosen,
  tree,
  onOpen,
  onChoose,
}: {
  nodes: SpecialtySummary[];
  openId: string | null;
  alreadyChosen: string[];
  tree: ReturnType<typeof buildTree>;
  onOpen: (id: string) => void;
  onChoose: (id: string) => void;
}) {
  return (
    <div className="border-rule bg-card min-w-[13rem] shrink-0 rounded-[var(--radius-sm)] border">
      <p className="text-muted border-rule border-b px-2 py-1.5 text-[0.6875rem] font-medium tracking-wide uppercase">
        {columnLabel(nodes)}
      </p>
      <ul className="max-h-64 overflow-y-auto p-1">
        {nodes.map((node) => {
          const hasChildren = childrenOf(tree, node.id).length > 0;
          const isOpen = openId === node.id;
          const chosen = alreadyChosen.includes(node.id);

          return (
            <li key={node.id} className="flex items-stretch gap-0.5">
              <button
                type="button"
                onClick={() => (hasChildren ? onOpen(node.id) : onChoose(node.id))}
                aria-expanded={hasChildren ? isOpen : undefined}
                className={`focus-visible:outline-focus-ring min-h-[1.75rem] flex-1 rounded-[var(--radius-xs)] px-2 py-1 text-left text-[0.8125rem] focus-visible:outline-2 focus-visible:-outline-offset-2 ${
                  isOpen ? 'bg-drape-tint text-drape-deep' : 'text-ink hover:bg-paper'
                }`}
              >
                {node.name}
                {hasChildren ? (
                  <span aria-hidden="true" className="text-muted ml-1">
                    ›
                  </span>
                ) : null}
              </button>

              {/*
                A node with children is still selectable in its own right — a
                doctor may be "a cardiologist" without any sub-specialty. The
                chevron opens, this picks. Without the split, choosing a parent
                would be impossible for exactly the broad categories most
                doctors have.
              */}
              {hasChildren ? (
                <button
                  type="button"
                  disabled={chosen}
                  onClick={() => onChoose(node.id)}
                  className="text-muted hover:text-drape-deep focus-visible:outline-focus-ring min-h-[1.75rem] min-w-[1.75rem] rounded-[var(--radius-xs)] px-1 text-[0.75rem] focus-visible:outline-2 focus-visible:-outline-offset-2"
                >
                  <span aria-hidden="true">+</span>
                  <span className="sr-only">
                    {chosen ? `${node.name} already added` : `Add ${node.name} itself`}
                  </span>
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
