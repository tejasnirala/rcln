'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import type {
  BranchDetail,
  DoctorScheduleDetail,
  DoctorSummary,
  FeeScheduleView,
  QualificationSummary,
  SpecialtySummary,
} from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { DoctorCreateForm } from '@/components/tenant/doctor-create-form';
import { ancestorLabel, buildTree, pathTo, subtreeIds } from '@/lib/taxonomy';
import { cn } from '@/lib/cn';

/**
 * The roster: who consults here, and when.
 *
 * ⚠️ THIS SCREEN NO LONGER EDITS ANYTHING, AND THAT IS THE POINT. Each row used
 *   to carry Edit, Working hours and History buttons with panels expanding
 *   underneath, which turned the list a receptionist reads twenty times a day
 *   into a control surface for the one administrator who could use it — while the
 *   profile you land on by clicking a doctor could not change a single thing
 *   about them. Both now do the job named on them: this one answers "who is here
 *   and when do they consult", and `/doctors/<id>` is where a doctor is changed.
 *   The only action left is registering a new one, which is not about any row.
 *
 * ⚠️ THE ROW IS ONE STRETCHED `<Link>`, THE SAME SHAPE AS THE DAY BOARD. A real
 *   anchor over the row keeps focus, middle-click, copy-link and the keyboard,
 *   none of which an `onClick` on a `<div>` has. Anything genuinely interactive
 *   would have to sit above it with `relative z-10` — there is nothing on a row
 *   that does, and the absence is deliberate per the note above.
 *
 * ⚠️ STATUS IS CARRIED BY WORDS, NEVER BY COLOUR ALONE (WCAG 1.4.1, and
 *   AGENTS.md lists it as a rule already got wrong once).
 */

/**
 * Sunday first, matching `dayOfWeek` 0–6 in the contract, which in turn matches
 * Postgres `extract(dow)`. Not a display preference — renumbering here would
 * silently shift every stored day.
 */
const DAYS = [
  { short: 'S', full: 'Sunday' },
  { short: 'M', full: 'Monday' },
  { short: 'T', full: 'Tuesday' },
  { short: 'W', full: 'Wednesday' },
  { short: 'T', full: 'Thursday' },
  { short: 'F', full: 'Friday' },
  { short: 'S', full: 'Saturday' },
] as const;

/**
 * A doctor's week, compact enough to sit in a list row.
 *
 * ⚠️ THE SEVEN CELLS ARE ALWAYS DRAWN, INCLUDING THE EMPTY ONES. The week is a
 *   real sequence, so its shape carries the answer the front desk actually wants
 *   — "is she in on Thursday?" — and a strip that listed only the working days
 *   would reflow to a different width on every row, so the day you are looking
 *   for is never in the same place twice.
 *
 * ⚠️ A DAY WITH SEVERAL BLOCKS SHOWS THE FIRST AND SAYS HOW MANY MORE. A doctor
 *   can hold a morning and an evening clinic, and flattening those to
 *   "09:00–17:00" would invent a bookable lunchtime. The profile lists every
 *   block in full; this is the summary, and it says so rather than lying.
 *
 * An empty day is a dash AND the word, never colour alone.
 */
function WeekStrip({ schedules }: { schedules: DoctorScheduleDetail[] }) {
  const active = schedules.filter((s) => s.isActive);

  if (active.length === 0) {
    return <p className="text-muted text-[0.75rem]">No working hours — not bookable</p>;
  }

  return (
    <ul className="flex gap-px">
      {DAYS.map((day, index) => {
        const blocks = active
          .filter((s) => s.dayOfWeek === index)
          .sort((a, b) => a.startTime.localeCompare(b.startTime));
        const first = blocks[0];

        return (
          <li
            key={day.full}
            className={`w-11 shrink-0 rounded-xs px-0.5 py-1 text-center ${
              first === undefined ? 'bg-paper' : 'bg-drape-tint/70'
            }`}
          >
            <p className="text-muted text-[0.625rem] font-medium" aria-hidden="true">
              {day.short}
            </p>
            <span className="sr-only">{day.full}: </span>

            {first === undefined ? (
              <p className="text-muted font-mono text-[0.625rem]">
                <span aria-hidden="true">—</span>
                <span className="sr-only">not consulting</span>
              </p>
            ) : (
              <p className="text-ink font-mono text-[0.5625rem] leading-tight">
                {first.startTime}
                <br />
                {first.endTime}
                {blocks.length > 1 ? (
                  <>
                    <span aria-hidden="true" className="text-muted block">
                      +{blocks.length - 1}
                    </span>
                    <span className="sr-only">
                      and {blocks.length - 1} more block{blocks.length > 2 ? 's' : ''}
                    </span>
                  </>
                ) : null}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function DoctorList({
  slug,
  doctors,
  branches,
  specialties,
  qualifications,
  candidates,
  fees,
  canReadSchedules,
  canManageSchedules,
  canCreate,
  canUpdate,
  canManageFees,
  canManagePay,
}: {
  slug: string;
  doctors: DoctorSummary[];
  branches: BranchDetail[];
  specialties: SpecialtySummary[];
  qualifications: QualificationSummary[];
  candidates: { userId: string; fullName: string }[];
  /** The clinic's own price sheet, for the registration form's currency and defaults. */
  fees: FeeScheduleView | null;
  canReadSchedules: boolean;
  canManageSchedules: boolean;
  canCreate: boolean;
  /** Gates the qualifications section of the registration form only. */
  canUpdate: boolean;
  canManageFees: boolean;
  canManagePay: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const closeCreate = useCallback(() => setAdding(false), []);

  const [filterId, setFilterId] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const tree = useMemo(() => buildTree(specialties), [specialties]);

  /*
   * ⚠️ FILTERING IS BY SUBTREE, NOT BY THE CHOSEN NODE. Picking "Cardiology"
   *   has to show the doctor tagged only "Structural Heart Disease" — their
   *   record contains the string "cardio" nowhere, so no name match can find
   *   them. `subtreeIds` mirrors what `GET /doctors?specialtyId=` does on the
   *   server; the filtering happens here only because the whole roster is
   *   already rendered and a round trip to re-fetch it would be slower and
   *   flash the list.
   */
  const visible = useMemo(() => {
    const term = nameQuery.trim().toLowerCase();
    const wanted = filterId ? subtreeIds(tree, filterId) : null;

    return doctors.filter((doctor) => {
      if (wanted && !doctor.specialties.some((s) => wanted.has(s.specialtyId))) return false;
      if (statusFilter && doctor.status !== statusFilter) return false;
      /*
       * A fragment of the name or of the council number, matched anywhere and
       * without case — "aman", "rao" and the four digits at the end of a
       * registration all find the same person. Nobody types a full name to
       * find a colleague they already know.
       */
      if (term === '') return true;
      return (
        doctor.fullName.toLowerCase().includes(term) ||
        (doctor.registrationNumber?.toLowerCase().includes(term) ?? false)
      );
    });
  }, [doctors, filterId, nameQuery, statusFilter, tree]);

  /**
   * The taxonomy filter, grouped by what KIND of node each option is.
   *
   * ⚠️ ONE CONTROL AND NOT THREE, THOUGH IT READS AS DEPARTMENT / SPECIALITY /
   *   SUB-SPECIALISATION. Those are labels on nodes of one tree, not three
   *   columns — the schema says so at length and warns against exactly the fixed
   *   triple that three selects would bake in. Cardiology and Structural Heart
   *   Disease are filtered by the same relation; only the subtree differs.
   *
   *   It matters because the tree is RAGGED. Medical runs Domain → Department →
   *   Specialty → Sub-specialty; Dental runs Domain → Specialty with no
   *   department at all. A rigid three-select cascade would show an empty
   *   "Department" for every dentist and could never grow a fifth level.
   *   `<optgroup>` gives the reader the same separation with none of that.
   *
   * ⚠️ AND ONLY NODES SOME DOCTOR HERE ACTUALLY SITS UNDER. A filter offering
   *   148 options, 140 of which return nothing, is a worse list than no filter.
   */
  const filterGroups = useMemo(() => {
    const used = new Set<string>();
    for (const doctor of doctors) {
      for (const s of doctor.specialties) {
        for (const ancestor of pathTo(tree, s.specialtyId)) used.add(ancestor.id);
      }
    }

    const nodes = [...used]
      .map((id) => tree.byId.get(id))
      .filter((n): n is SpecialtySummary => n !== undefined);

    /*
     * The order a clinic thinks in — broad to narrow. A type nobody here uses
     * contributes no group rather than an empty one.
     */
    const LEVELS: { type: SpecialtySummary['type']; label: string }[] = [
      { type: 'DOMAIN', label: 'Areas' },
      { type: 'DEPARTMENT', label: 'Departments' },
      { type: 'SPECIALTY', label: 'Specialities' },
      { type: 'SUB_SPECIALTY', label: 'Sub-specialisations' },
      { type: 'FOCUS_AREA', label: 'Focus areas' },
      { type: 'EXPERTISE', label: 'Expertise' },
    ];

    return LEVELS.flatMap(({ type, label }) => {
      const options = nodes
        .filter((n) => n.type === type)
        .map((n) => ({
          value: n.id,
          /* The ancestor path disambiguates two nodes that share a name. */
          label: [ancestorLabel(tree, n.id), n.name].filter(Boolean).join(' › '),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));

      return options.length === 0 ? [] : [{ label, options }];
    });
  }, [doctors, tree]);

  const optionCount = useMemo(
    () => filterGroups.reduce((total, group) => total + group.options.length, 0),
    [filterGroups]
  );

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow text-drape">Practitioners</p>
          <h1 className="font-display mt-2 text-3xl tracking-tight">Doctors</h1>
          <p className="text-muted mt-2 max-w-xl text-[0.9375rem] leading-relaxed">
            Who consults here, and when. Working hours decide which appointment slots the front desk
            can offer. Open a doctor to change anything about them.
          </p>
        </div>
        {canCreate && candidates.length > 0 ? (
          <Button onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
            {adding ? 'Cancel' : 'Add a doctor'}
          </Button>
        ) : null}
      </div>

      {adding ? (
        <div className="border-drape bg-drape-tint/40 mt-6 rounded-lg border p-5">
          <DoctorCreateForm
            slug={slug}
            candidates={candidates}
            specialties={specialties}
            qualifications={qualifications}
            branches={branches}
            fees={fees}
            canManageSchedules={canManageSchedules}
            canManageQualifications={canUpdate}
            canManageFees={canManageFees}
            canManagePay={canManagePay}
            onDone={closeCreate}
            onCancel={closeCreate}
          />
        </div>
      ) : null}

      {/*
        The same control strip as the invoice ledger: no stacked labels, each
        control naming itself through its empty option, muted until it is
        narrowing something. This is a roster somebody scans, so the filters sit
        on one line above it rather than in a card of their own.

        ⚠️ ALL OF IT FILTERS ROWS ALREADY IN HAND. The whole roster is rendered
          — `GET /doctors` returns it in one call — so a round trip to re-fetch a
          subset would be slower and would flash the list. None of it is in the
          URL for the same reason: nothing here changes WHICH rows were fetched.
      */}
      {doctors.length > 1 ? (
        <div className="mt-8 flex flex-wrap items-center gap-2">
          <Input
            name="doctorSearch"
            aria-label="Search doctors"
            placeholder="Name or council number"
            value={nameQuery}
            onChange={(event) => setNameQuery(event.target.value)}
            className="w-auto min-w-[14rem] flex-1"
          />

          {optionCount > 1 ? (
            <Select
              name="specialtyFilter"
              aria-label="Department, speciality or sub-specialisation"
              value={filterId}
              onChange={(event) => setFilterId(event.target.value)}
              className={cn('w-[18rem]', filterId ? undefined : 'text-muted')}
              options={[{ value: '', label: 'Any department or speciality' }, ...filterGroups]}
            />
          ) : null}

          <Select
            name="statusFilter"
            aria-label="Status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className={cn('w-[10rem]', statusFilter ? undefined : 'text-muted')}
            options={[
              { value: '', label: 'Any status' },
              { value: 'ACTIVE', label: 'Consulting' },
              { value: 'INACTIVE', label: 'Paused' },
              { value: 'ARCHIVED', label: 'Archived' },
            ]}
          />

          <span className="text-muted ml-auto text-[0.8125rem]">
            {/*
              Says what the filters did, which is the one thing a strip without
              labels cannot show on its own. Also the answer to "did I break it?"
              when a search returns nothing.
            */}
            {visible.length === doctors.length
              ? `${String(doctors.length)} doctors`
              : `${String(visible.length)} of ${String(doctors.length)}`}
          </span>
        </div>
      ) : null}

      {filterId ? (
        <p className="text-muted mt-2 text-[0.8125rem]">
          Choosing a broad area also shows everyone trained in something under it.
        </p>
      ) : null}

      {doctors.length === 0 ? (
        <div className="border-rule bg-card mt-8 rounded-lg border border-dashed p-8 text-center">
          <p className="text-ink text-[0.9375rem] font-medium">No doctors yet</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem] leading-relaxed">
            {candidates.length === 0
              ? 'Invite a colleague from Staff first — a doctor needs a login before they can be scheduled or sign a prescription.'
              : 'Register a colleague as a doctor. You will be asked for their council number, what they treat, the hours they consult and what they are paid, all in one go.'}
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="border-rule bg-card mt-8 rounded-lg border border-dashed p-8 text-center">
          <p className="text-ink text-[0.9375rem] font-medium">Nobody in that area</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem] leading-relaxed">
            No doctor here is classified under it yet.
          </p>
          <div className="mt-4">
            <Button variant="secondary" onClick={() => setFilterId('')}>
              Show everyone
            </Button>
          </div>
        </div>
      ) : (
        <ol className="border-rule bg-card divide-rule mt-8 divide-y overflow-hidden rounded-md border">
          {visible.map((doctor) => (
            <li key={doctor.id}>
              <DoctorRow doctor={doctor} canReadSchedules={canReadSchedules} />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function DoctorRow({
  doctor,
  canReadSchedules,
}: {
  doctor: DoctorSummary;
  canReadSchedules: boolean;
}) {
  /*
   * The classification, most specific last. `primarySpecialty` is only the name,
   * so the primary ENTRY is looked up for its ancestor chain — "Structural Heart
   * Disease" alone is not a specialty anybody can place, and the chain is what
   * makes it read as part of Cardiology. Derived on the server and never stored;
   * see `doctorSpecialtyDetail.ancestors`.
   */
  const primary = doctor.specialties.find((s) => s.isPrimary) ?? doctor.specialties[0];
  const ancestry = primary?.ancestors.map((a) => a.name).join(' › ') ?? '';
  const others = doctor.specialties.length - (primary === undefined ? 0 : 1);

  return (
    <div className="relative flex flex-wrap items-start gap-4 px-4 py-3 transition-colors hover:bg-[color-mix(in_oklab,var(--color-drape)_6%,transparent)] focus-within:bg-[color-mix(in_oklab,var(--color-drape)_6%,transparent)]">
      {/*
        The whole row is the link, and it is the only one on it — the same shape
        the day board uses. The visible text is spread across several elements and
        reads as a fragment out of context, so the target is named once in full
        for anyone arriving by keyboard or screen reader.
      */}
      <Link
        href={`/doctors/${doctor.id}`}
        className="absolute inset-0 rounded-sm"
        aria-label={`Open ${doctor.fullName}'s profile`}
      >
        <span className="sr-only">Open this profile</span>
      </Link>

      <div className="min-w-52 flex-1">
        <p className="text-ink text-[0.9375rem]">
          {doctor.fullName}
          {/* The word, not a highlight — colour is never the only carrier. */}
          {doctor.status !== 'ACTIVE' ? (
            <span className="text-muted ml-2 text-[0.75rem]">
              {doctor.status === 'INACTIVE' ? 'Not consulting' : 'Retired'}
            </span>
          ) : null}
        </p>
        <p className="text-muted mt-0.5 text-[0.8125rem]">
          {primary === undefined ? 'No specialty recorded' : primary.name}
          {others > 0 ? <span className="text-muted"> +{others}</span> : null}
        </p>
        {ancestry !== '' ? (
          <p className="text-muted mt-0.5 font-mono text-[0.6875rem] tracking-tight">{ancestry}</p>
        ) : null}
      </div>

      <p className="text-muted w-24 shrink-0 text-[0.8125rem]">
        {doctor.experienceYears === null ? (
          <span>
            <span aria-hidden="true">—</span>
            <span className="sr-only">Experience not recorded</span>
          </span>
        ) : (
          <>
            <span className="text-ink font-mono tabular-nums">{doctor.experienceYears}</span> years
          </>
        )}
      </p>

      {/* A council registration number is an identifier read aloud and copied
          onto a prescription, so it is set in mono like the UHID. */}
      <p className="w-36 shrink-0 font-mono text-[0.75rem]">
        <span className="sr-only">Medical council number: </span>
        {doctor.registrationNumber ?? (
          <span className="text-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">not recorded</span>
          </span>
        )}
      </p>

      {/*
        ⚠️ ABSENT MEANS THE CALLER MAY NOT READ SCHEDULES, AND THE COLUMN SIMPLY
          IS NOT ON THEIR SCREEN. The API omits the field rather than sending an
          empty array for exactly this reason — rendering "no working hours" to
          someone who was never allowed to know would be a claim where the
          silence is the truth. Same three-state shape as `liveInvoice`.
      */}
      {canReadSchedules && doctor.schedules !== undefined ? (
        <div className="shrink-0">
          <WeekStrip schedules={doctor.schedules} />
        </div>
      ) : null}
    </div>
  );
}
