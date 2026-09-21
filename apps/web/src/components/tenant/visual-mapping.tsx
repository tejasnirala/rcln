'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import {
  drawableRegions,
  labelAnchorOf,
  parseVisualMap,
  regionGroups,
  type MapRegion,
  type VisualMapDocument,
} from '@rcln/clinical';
import type { ClinicalFinding, EncounterDiagnosis, VisualMapDetail } from '@rcln/contracts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import {
  Empty,
  Row,
  RowSelect,
  RowText,
  TermPicker,
  type ContentSectionProps,
} from '@/components/tenant/consultation-content';
import { searchClinicalTerms } from '@/app/(tenant)/t/[slug]/(app)/appointments/consultation-actions';

/**
 * The visual mapping engine (CE-6) — the chart a clinician draws on.
 *
 * ⚠️ IT IS `VisualMappingEngine` AND NOT `DentalChart` (§23), AND THE NAME IS
 *   THE ARCHITECTURE. There is no tooth in this file, no quadrant, no dental
 *   anything: it draws whatever regions the server handed it, in whatever
 *   coordinate space the map declares. The odontogram is thirty-six rows in a
 *   seed. CE-7 adds the scalp map and the body map the same way, and its
 *   definition of done is that no second component was needed.
 *
 * ⚠️ AND NO SPECIALTY ANYWHERE (§33). Same rule as every other component in the
 *   consultation. The server resolved which chart this section draws; this
 *   renders exactly that.
 *
 * ⚠️ NO CLINICAL DATA IN THE PICTURE (§22). The SVG carries region ids and
 *   geometry. Every mark on it is a `clinical_findings` row read back and drawn
 *   — which is what makes the chart queryable, reportable, auditable and
 *   amendable, none of which a coloured-in drawing would be.
 *
 * ── THE ONE VISUAL DECISION, AND WHY IT IS THE ONLY ONE ──────────────────────
 *
 * This is the only PICTURE in the product, so it is where the design spends its
 * boldness — everything around it stays in the quiet, dense form the rest of the
 * consultation is (apps/web/AGENTS.md). A region is an outline; a region with
 * findings on it is filled with the accent tint and carries one dot per finding
 * under its label. The dots encode something true — how much has been recorded
 * there — rather than decorating the chart, and they are what lets a clinician
 * read the whole mouth at a glance instead of clicking thirty-two times.
 *
 * ⚠️ SEVERITY IS DELIBERATELY NOT A COLOUR. Three tints nobody has been taught
 *   to read is a legend, not information — and the accent palette is a user
 *   preference with five settings, so a severity ramp built from it would mean
 *   something different per clinic. Severity is a word, on the row.
 *
 * ⚠️ EVERY COLOUR IS A TOKEN. `theme.css` is five accents × two appearances and
 *   nothing in this file may have an opinion about which.
 */

/** How many dots a region shows before it says "and more". */
const MAX_DOTS = 3;

// ---------------------------------------------------------------------------
// The chart itself
// ---------------------------------------------------------------------------

export interface ChartMark {
  /** How many findings are recorded on this region. */
  count: number;
}

/**
 * A map, drawn.
 *
 * ⚠️ PURE, AND SHARED BY THREE SCREENS — the consultation, the read-only record
 *   and the chart admin's preview. A second renderer for the preview is how the
 *   two start disagreeing about what a clinic's chart looks like.
 *
 * ⚠️ THE REGIONS ARE KEYBOARD-REACHABLE, and that is not decoration either. A
 *   `<g>` is not a button, so each carries `role="button"`, a tab stop and
 *   Enter/Space — without which the chart is a control a keyboard user cannot
 *   operate at all.
 */
export function VisualMapChart({
  map,
  marks,
  selectedId,
  onSelect,
  labelledBy,
}: {
  map: VisualMapDocument;
  /** Region id → what is recorded there. Empty on the admin preview. */
  marks: ReadonlyMap<string, ChartMark>;
  selectedId: string | null;
  onSelect: ((region: MapRegion) => void) | null;
  labelledBy?: string | undefined;
}) {
  const regions = drawableRegions(map);
  const { minX, minY, width, height } = map.viewBox;

  return (
    <svg
      viewBox={`${minX} ${minY} ${width} ${height}`}
      className="border-rule bg-paper w-full rounded-lg border"
      role="group"
      {...(labelledBy !== undefined ? { 'aria-labelledby': labelledBy } : {})}
    >
      {regions.map((region) => {
        const mark = marks.get(region.id);
        const selected = region.id === selectedId;
        const anchor = labelAnchorOf(region);
        const interactive = onSelect !== null;

        return (
          <g
            key={region.id}
            {...(interactive
              ? {
                  role: 'button',
                  tabIndex: 0,
                  'aria-pressed': selected,
                  onClick: () => onSelect(region),
                  onKeyDown: (event: React.KeyboardEvent<SVGGElement>) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(region);
                    }
                  },
                  className: 'cursor-pointer focus:outline-none',
                }
              : {})}
            aria-label={
              mark === undefined ? region.label : `${region.label} — ${mark.count} recorded`
            }
          >
            <RegionShape
              region={region}
              className={cn(
                'transition-colors',
                mark === undefined ? 'fill-card' : 'fill-drape-tint',
                selected ? 'stroke-drape' : 'stroke-rule'
              )}
              strokeWidth={selected ? 3 : 1.5}
            />
            {anchor === null ? null : (
              <>
                <text
                  x={anchor.x}
                  y={anchor.y - 4}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className={cn(
                    'pointer-events-none select-none text-[13px]',
                    mark === undefined ? 'fill-muted' : 'fill-ink'
                  )}
                >
                  {region.label}
                </text>
                {mark === undefined ? null : (
                  <FindingDots x={anchor.x} y={anchor.y + 12} count={mark.count} />
                )}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function RegionShape({
  region,
  className,
  strokeWidth,
}: {
  region: MapRegion;
  className: string;
  strokeWidth: number;
}) {
  const geometry = region.geometry;
  /* Unreachable: `drawableRegions` filtered these out. Stated rather than
     asserted, because a `!` here would be the one the lint rule forbids. */
  if (geometry === null) return null;

  const shape = geometry.shape;
  if (shape.kind === 'RECT') {
    return (
      <rect
        x={shape.x}
        y={shape.y}
        width={shape.width}
        height={shape.height}
        {...(shape.radius !== undefined ? { rx: shape.radius, ry: shape.radius } : {})}
        className={className}
        strokeWidth={strokeWidth}
      />
    );
  }
  if (shape.kind === 'CIRCLE') {
    return (
      <circle
        cx={shape.cx}
        cy={shape.cy}
        r={shape.r}
        className={className}
        strokeWidth={strokeWidth}
      />
    );
  }
  return <path d={shape.d} className={className} strokeWidth={strokeWidth} />;
}

/** One dot per finding, up to three, then a plus. */
function FindingDots({ x, y, count }: { x: number; y: number; count: number }) {
  const dots = Math.min(count, MAX_DOTS);
  const spacing = 7;
  const first = x - ((dots - 1) * spacing) / 2;

  return (
    <g className="pointer-events-none">
      {Array.from({ length: dots }, (_, index) => (
        <circle key={index} cx={first + index * spacing} cy={y} r={2.5} className="fill-drape" />
      ))}
      {count > MAX_DOTS ? (
        <text
          x={x + (dots * spacing) / 2 + 4}
          y={y}
          dominantBaseline="middle"
          className="fill-drape select-none text-[10px]"
        >
          +{count - MAX_DOTS}
        </text>
      ) : null}
    </g>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

const SEVERITIES = [
  { value: 'MILD', label: 'Mild' },
  { value: 'MODERATE', label: 'Moderate' },
  { value: 'SEVERE', label: 'Severe' },
];

export interface VisualMappingSectionProps extends ContentSectionProps {
  /** The section's own key — findings hang off it, because the type repeats. */
  sectionKey: string;
  /** The chart the server resolved from the section's `mapCode`. */
  map?: VisualMapDetail | undefined;
  /** What the template asked for, for the sentence when the map is missing. */
  mapCode?: string | undefined;
}

export function VisualMappingSection(props: VisualMappingSectionProps) {
  const { slug, content, readOnly, scopeIds, sectionKey, map, mapCode, add, edit, remove } = props;
  const headingId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const findings = useMemo(
    () => content.findings.filter((finding) => finding.sectionKey === sectionKey),
    [content.findings, sectionKey]
  );

  const parsed = useMemo(
    () =>
      map === undefined
        ? null
        : parseVisualMap({
            code: map.code,
            viewBox: map.viewBox,
            regions: map.regions,
          }),
    [map]
  );

  const marks = useMemo(() => {
    const counts = new Map<string, ChartMark>();
    for (const finding of findings) {
      const existing = counts.get(finding.region.id);
      counts.set(finding.region.id, { count: (existing?.count ?? 0) + 1 });
    }
    return counts;
  }, [findings]);

  const search = useCallback(
    (term: string, allSpecialties: boolean) =>
      searchClinicalTerms(slug, 'FINDING_TYPE', term, scopeIds ?? [], allSpecialties),
    [slug, scopeIds]
  );

  /*
   * ⚠️ THE SENTENCE, NOT A BLANK SPACE. A clinic that configured a chart and
   *   sees nothing assumes the whole consultation is broken; being told the
   *   chart is missing names the thing somebody has to fix, which is usually a
   *   map that was deactivated after the template started citing it.
   */
  if (map === undefined || parsed === null) {
    return (
      <p className="text-muted text-[0.9375rem]">
        This section draws a chart{mapCode === undefined ? '' : ` (${mapCode})`} that is not
        available at this clinic. Ask an administrator to check it under Charts.
      </p>
    );
  }

  if (!parsed.ok) {
    return (
      <p className="text-muted text-[0.9375rem]">
        This chart cannot be drawn: {parsed.problem}. Nothing recorded on it is lost.
      </p>
    );
  }

  const document = parsed.value;
  const selected = document.regions.find((region) => region.id === selectedId) ?? null;
  const selectedFindings =
    selected === null ? [] : findings.filter((finding) => finding.region.id === selected.id);

  return (
    <div>
      <p id={headingId} className="sr-only">
        {map.name}
      </p>

      <VisualMapChart
        map={document}
        marks={marks}
        selectedId={selectedId}
        onSelect={(region) => setSelectedId(region.id === selectedId ? null : region.id)}
        labelledBy={headingId}
      />

      {/*
        The regions as a list, always — not a fallback.

        ⚠️ A CHART IS A PICTURE AND SOME PEOPLE DO NOT SEE IT. The groups below
        are the same regions as buttons in a real tab order, which is how a
        screen-reader user and a keyboard user reach a tooth without hunting
        through an SVG. It is also the only way a map whose regions carry no
        geometry is usable at all.
      */}
      <RegionPicker map={document} marks={marks} selectedId={selectedId} onSelect={setSelectedId} />

      {selected === null ? (
        <div className="mt-4">
          {findings.length === 0 ? (
            <Empty what="on this chart" />
          ) : (
            <ul>
              {findings.map((finding) => (
                <li key={finding.id} className="border-rule border-t py-2 first:border-t-0">
                  <button
                    type="button"
                    className="hover:text-drape text-left text-[0.9375rem] underline-offset-2 hover:underline"
                    onClick={() => setSelectedId(finding.region.id)}
                  >
                    {finding.region.label} — {finding.item.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="border-rule mt-4 rounded-lg border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h4 className="text-[0.9375rem]">{selected.label}</h4>
            <Button variant="ghost" onClick={() => setSelectedId(null)}>
              Close
            </Button>
          </div>

          {selectedFindings.length === 0 ? (
            <p className="text-muted mt-2 text-[0.9375rem]">Nothing recorded here.</p>
          ) : (
            <ul className="mt-2">
              {selectedFindings.map((finding) => (
                <FindingRow
                  key={finding.id}
                  finding={finding}
                  diagnoses={content.diagnoses}
                  readOnly={readOnly}
                  onEdit={(body) => void edit('findings', finding.id, body)}
                  onRemove={() => void remove('findings', finding.id)}
                />
              ))}
            </ul>
          )}

          {readOnly ? null : (
            <div className="mt-4">
              <TermPicker
                label={`Record on ${selected.label}`}
                hint="What you see here. The diagnosis it adds up to is the Diagnosis section — link them below."
                disabled={readOnly}
                search={search}
                canWiden={(scopeIds?.length ?? 0) > 0}
                onPick={(picked) => {
                  /*
                   * ⚠️ A TYPED FINDING IS NOT ACCEPTED, UNLIKE A TYPED SYMPTOM.
                   *   `finding_item_id` is NOT NULL: the region already says
                   *   WHERE, so a mark with no coded word is a mark nobody can
                   *   read back. The picker still lets the words be typed —
                   *   this tells them what to do with them.
                   */
                  if (!('id' in picked)) return;
                  void add('findings', {
                    sectionKey,
                    visualRegionId: selected.id,
                    findingItemId: picked.id,
                  });
                }}
              />
              <p className="text-muted mt-2 text-[0.8125rem]">
                Pick a term from the list. A finding is recorded against the chart, so it has to be
                one the clinic has a word for — add it under Clinical terms if it is missing.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The regions as buttons, grouped the way the map groups them. */
function RegionPicker({
  map,
  marks,
  selectedId,
  onSelect,
}: {
  map: VisualMapDocument;
  marks: ReadonlyMap<string, ChartMark>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const groups = regionGroups(map);

  return (
    <div className="mt-4 space-y-3">
      {groups.map((group) => {
        /* A flat map has no groups: every region is its own "group" of one, and
           the heading would then be the region's own label repeated. */
        const regions = group.children.length > 0 ? group.children : [group.region];
        const heading = group.children.length > 0 ? group.region.label : null;

        return (
          <div key={group.region.id}>
            {heading === null ? null : <p className="eyebrow text-drape">{heading}</p>}
            <div className={cn('flex flex-wrap gap-1', heading === null ? null : 'mt-1.5')}>
              {regions.map((region) => (
                <button
                  key={region.id}
                  type="button"
                  aria-pressed={region.id === selectedId}
                  onClick={() => onSelect(region.id === selectedId ? null : region.id)}
                  className={cn(
                    'border-rule rounded border px-2 py-1 text-[0.8125rem]',
                    marks.has(region.id) ? 'bg-drape-tint' : 'bg-card',
                    region.id === selectedId ? 'border-drape text-drape' : 'text-muted'
                  )}
                >
                  {region.label}
                  {marks.has(region.id) ? ` · ${marks.get(region.id)?.count ?? 0}` : ''}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FindingRow({
  finding,
  diagnoses,
  readOnly,
  onEdit,
  onRemove,
}: {
  finding: ClinicalFinding;
  diagnoses: readonly EncounterDiagnosis[];
  readOnly: boolean;
  onEdit: (body: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  /*
   * ⚠️ THE DIAGNOSIS LIST IS THIS CONSULTATION'S OWN, AND THAT IS ENFORCED ON
   *   THE SERVER TOO. A finding may only explain a diagnosis recorded at the
   *   same visit — the composite FK says "same tenant" and the service says
   *   "same encounter".
   */
  const diagnosisOptions = [
    { value: '', label: 'Not linked' },
    ...diagnoses.map((diagnosis) => ({
      value: diagnosis.id,
      label: diagnosis.item?.name ?? diagnosis.customText ?? 'Recorded in your own words',
    })),
  ];

  return (
    <Row title={finding.item.name} readOnly={readOnly} onRemove={onRemove}>
      <div className="grid gap-3 sm:grid-cols-3">
        <RowSelect
          label="Severity"
          value={finding.severity}
          options={SEVERITIES}
          placeholder="Not recorded"
          disabled={readOnly}
          onCommit={(value) => onEdit({ severity: value === '' ? null : value })}
        />
        <RowSelect
          label="Explains"
          value={finding.diagnosisId}
          options={diagnosisOptions}
          disabled={readOnly}
          onCommit={(value) => onEdit({ diagnosisId: value === '' ? null : value })}
        />
        <RowText
          label="Notes"
          value={finding.notes}
          disabled={readOnly}
          onCommit={(value) => onEdit({ notes: value })}
        />
      </div>
    </Row>
  );
}
