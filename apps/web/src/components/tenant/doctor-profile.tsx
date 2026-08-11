import Link from 'next/link';
import type {
  BranchDetail,
  BranchSummary,
  DoctorCompensationDetail,
  DoctorDetail,
  FeeScheduleView,
  QualificationSummary,
  SpecialtySummary,
} from '@rcln/contracts';
import { formatClinicDate } from '@/lib/format';
import { DoctorPayPanel } from '@/components/tenant/doctor-pay-panel';
import { DoctorPanel, PanelEmpty } from '@/components/tenant/doctor-panel';
import {
  DoctorAboutPanel,
  DoctorHoursPanel,
  DoctorIdentityCard,
  DoctorQualificationsPanel,
  DoctorSpecialtiesPanel,
} from '@/components/tenant/doctor-sections';
import { FeeScheduleGrid } from '@/components/tenant/fee-schedule-grid';
import { RecordHistory } from '@/components/tenant/record-history';

/**
 * One practitioner's profile — and, for whoever holds the codes, where they are
 * changed.
 *
 * ⚠️ THIS IS NOW THE EDITING SCREEN, WHICH IT DELIBERATELY WAS NOT BEFORE. The
 *   panels used to live on the roster, one pair of buttons per row, so the list
 *   a receptionist reads all day carried controls only an administrator could
 *   use — while this page, the one you land on by clicking a doctor, could not
 *   change a single thing about them. The editing surface follows the record.
 *
 * ⚠️ THE READ-ONLY CASE IS STILL THE DEFAULT, AND STILL HAS NO DISABLED CONTROLS.
 *   Every editing prop defaults to false, so the two callers who may only look —
 *   the front desk, and a doctor viewing their own profile through
 *   `/profile` — get exactly the screen they got before. Greyed-out inputs would
 *   advertise a door that is locked for everyone who can see it.
 *
 * NOT PHI. Registration numbers, qualifications and consulting fees are facts
 * about a member of staff, several of them published on the clinic's own
 * website. No `data_access_logs` row is written for opening this, deliberately —
 * see `getDoctor` in the API for why diluting that table would be the harm.
 *
 * Quiet and conventional, per apps/web/AGENTS.md: this is an inside-the-app
 * reference screen, so it inherits the card, the eyebrow and the mono treatment
 * for identifiers from the patient chart rather than introducing anything.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const EXCEPTION_WORDS: Record<string, string> = {
  LEAVE: 'Leave',
  BLOCK: 'Blocked out',
  EXTRA_SHIFT: 'Extra shift',
};

const STATUS_WORDS: Record<DoctorDetail['status'], string> = {
  ACTIVE: 'Practising here',
  INACTIVE: 'Not currently practising',
  ARCHIVED: 'Retired from this clinic',
};

/** 09:00, from the "09:00:00" the API sends. */
function clockTime(value: string): string {
  return value.slice(0, 5);
}

export function DoctorProfile({
  doctor,
  timezone,
  backHref,
  backLabel,
  slug,
  fees = null,
  branches = [],
  compensation = null,
  canEditFees = false,
  canEditPay = false,
  specialties = [],
  qualifications = [],
  editableBranches = [],
  canUpdate = false,
  canManageSchedules = false,
  canArchive = false,
  canReadHistory = false,
}: {
  doctor: DoctorDetail;
  /**
   * The clinic's zone, from `timezoneOf`.
   *
   * ⚠️ THE READER'S CLINIC, NOT THE EXCEPTION'S BRANCH. A leave row can be
   *   org-wide (`branchId` null), so there is not always a branch to take one
   *   from; the person reading the roster wants it in the zone they work in.
   *   Never the runtime's — see `formatClinicDate`.
   */
  timezone: string;
  /** Omitted for a doctor viewing their own profile — they came from a menu. */
  backHref?: string;
  backLabel?: string;
  /**
   * The money panels below, all optional and all defaulting to absent.
   *
   * ⚠️ NULL MEANS "NOT FOR THIS READER", AND THE PANEL DISAPPEARS RATHER THAN
   *   RENDERING EMPTY. A lab assistant opening a colleague's profile holds
   *   `doctor.read` and neither fee nor pay code; a greyed-out salary box would
   *   advertise a door that is locked, which this screen's header note already
   *   argues against for the edit affordances.
   */
  slug?: string;
  fees?: FeeScheduleView | null;
  branches?: BranchSummary[];
  compensation?: DoctorCompensationDetail | null;
  canEditFees?: boolean;
  canEditPay?: boolean;
  /**
   * The catalogues and branches the editing panels need.
   *
   * Empty by default, and only ever fetched by the roster's detail page — the
   * self-profile screen has no editing and should not pay for three extra calls
   * to render a form it will not show.
   */
  specialties?: SpecialtySummary[];
  qualifications?: QualificationSummary[];
  /**
   * ⚠️ DELIBERATELY NOT CALLED `branches`, BECAUSE THAT PROP ALREADY EXISTS AND
   *   MEANS SOMETHING ELSE. `branches` is `BranchSummary` for the fee grid's
   *   pricing scopes; this is the full `BranchDetail` the working-hours form
   *   posts against. Two props of the same name and different type is how a call
   *   site passes the wrong one and only finds out when a form 404s on a branch.
   */
  editableBranches?: BranchDetail[];
  canUpdate?: boolean;
  canManageSchedules?: boolean;
  canArchive?: boolean;
  canReadHistory?: boolean;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {backHref !== undefined ? (
          <Link href={backHref} className="text-muted text-[0.8125rem] hover:underline">
            ← {backLabel ?? 'Back'}
          </Link>
        ) : (
          <span />
        )}

        {/*
          ⚠️ THE TRAIL MOVED HERE FROM THE ROSTER, WHERE IT SAT AT THE END OF
            EVERY ROW. "What changed about this doctor, and who changed it" is a
            question about ONE doctor, asked while looking at them — not a column
            on a list. Behind `audit.record.read`, which is a narrower code than
            reading the roster.
        */}
        {canReadHistory && slug !== undefined ? (
          <RecordHistory
            slug={slug}
            entityType="doctor_profile"
            entityId={doctor.id}
            label={doctor.fullName}
          />
        ) : null}
      </div>

      {/*
        ⚠️ EVERY SECTION BELOW EDITS ITSELF, AND `slug === undefined` IS WHAT MAKES
          THEM READ-ONLY. The doctor's own `/profile` screen passes no slug — it
          has no server action to bind to and nothing on it is editable — so the
          same components render exactly the reference view this file has always
          shown. `canEdit` then narrows it further by permission.
      */}
      {slug === undefined ? (
        <ReadOnlyIdentity doctor={doctor} />
      ) : (
        <DoctorIdentityCard
          slug={slug}
          doctor={doctor}
          canEdit={canUpdate}
          canArchive={canArchive}
        />
      )}

      {slug !== undefined ? (
        <DoctorAboutPanel slug={slug} doctor={doctor} canEdit={canUpdate} />
      ) : doctor.bio !== null ? (
        <DoctorPanel title="About">
          <p className="mt-3 text-[0.9375rem] whitespace-pre-line">{doctor.bio}</p>
        </DoctorPanel>
      ) : null}

      {slug !== undefined ? (
        <DoctorSpecialtiesPanel
          slug={slug}
          doctor={doctor}
          specialties={specialties}
          canEdit={canUpdate}
        />
      ) : (
        <ReadOnlySpecialties doctor={doctor} />
      )}

      {slug !== undefined ? (
        <DoctorQualificationsPanel
          slug={slug}
          doctor={doctor}
          qualifications={qualifications}
          canEdit={canUpdate}
        />
      ) : (
        <ReadOnlyQualifications doctor={doctor} />
      )}

      {/* ⚠️ NO LONGER "and fees". Prices moved to the fee schedule, which is per
          visit type and inherits the clinic's default — this panel is now only
          where the doctor consults and how long a revisit stays free. */}
      <DoctorPanel title="Clinics" note="Where this doctor consults.">
        {doctor.branchSettings.length === 0 ? (
          <PanelEmpty>Not set up at any clinic yet.</PanelEmpty>
        ) : (
          <ul className="mt-3 space-y-3">
            {doctor.branchSettings.map((setting) => (
              <li key={setting.id}>
                <p className="text-[0.9375rem]">
                  {setting.branchName}
                  {/* Spelled out, not implied by dimming the row. */}
                  {!setting.isActive ? (
                    <span className="text-muted"> · not consulting here</span>
                  ) : null}
                </p>
                {setting.followUpFreeDays !== null ? (
                  <p className="text-muted mt-0.5 text-[0.75rem]">
                    Revisit free within {setting.followUpFreeDays} days
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </DoctorPanel>

      {/*
        ⚠️ TWO AMOUNTS, ADJACENT, IN OPPOSITE DIRECTIONS. What a patient pays for
           a visit and what the clinic pays the doctor giving it are unrelated
           facts that look alike on a screen — `PER_SESSION` pay and a
           per-appointment fee especially. Each panel says which way the money
           goes rather than leaving the heading to carry it.
      */}
      {fees !== null && slug !== undefined ? (
        <DoctorPanel
          title="What patients pay"
          note="This doctor’s prices. A blank row uses the clinic’s price; the amount is fixed onto an appointment when it is booked."
        >
          <FeeScheduleGrid
            slug={slug}
            doctorProfileId={doctor.id}
            branches={branches}
            initial={fees}
            canEdit={canEditFees}
          />
        </DoctorPanel>
      ) : null}

      {compensation !== null && slug !== undefined ? (
        <DoctorPanel
          title="What the clinic pays"
          note="What has been agreed with this doctor. A record of the agreement — rcln does not pay it out."
        >
          <DoctorPayPanel
            slug={slug}
            doctorId={doctor.id}
            compensation={compensation}
            canEdit={canEditPay}
          />
        </DoctorPanel>
      ) : null}

      {slug !== undefined ? (
        <DoctorHoursPanel
          slug={slug}
          doctor={doctor}
          branches={editableBranches}
          canEdit={canManageSchedules}
        />
      ) : (
        <ReadOnlyHours doctor={doctor} />
      )}

      {doctor.exceptions.length > 0 ? (
        <DoctorPanel title="Leave and changes" note="Days that differ from the hours above.">
          <ul className="mt-3 space-y-2">
            {doctor.exceptions.map((exception) => (
              <li key={exception.id} className="text-[0.9375rem]">
                {/*
                  ⚠️ THE CLINIC'S ZONE, NOT THE RUNTIME'S. `startsAt` is an
                    instant: leave beginning at 00:00 on the 11th in Kolkata is
                    18:30 on the 10th in UTC, so a bare `toLocaleDateString()`
                    printed the wrong DAY — and a day is the whole content of
                    this line.
                */}
                {EXCEPTION_WORDS[exception.exceptionType]} ·{' '}
                {formatClinicDate(exception.startsAt, timezone)}
                <span className="text-muted text-[0.75rem]">
                  {' · '}
                  {exception.status.toLowerCase()}
                  {exception.branchName !== null ? ` · ${exception.branchName}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </DoctorPanel>
      ) : null}
    </div>
  );
}

/*
 * The read-only halves, for a screen with no slug to bind an action to.
 *
 * ⚠️ THESE EXIST SO `/profile` STAYS A SERVER-RENDERED PAGE. The editable
 *   sections are client components; rendering them with every `canEdit` false
 *   would work and would still ship their bundle — the picker, four forms and
 *   the action bindings — to a screen that can change nothing. A doctor reading
 *   their own profile should not pay for the administrator's tooling.
 */

function ReadOnlyIdentity({ doctor }: { doctor: DoctorDetail }) {
  const primary = doctor.specialties.find((s) => s.isPrimary);

  return (
    <header className="border-rule bg-card mt-4 flex flex-wrap items-start justify-between gap-6 rounded-lg border p-5">
      <div className="min-w-0">
        <h1 className="font-display text-3xl tracking-tight">{doctor.fullName}</h1>
        <p className="text-muted mt-2 text-[0.9375rem]">
          {primary?.name ?? doctor.primarySpecialty ?? 'No specialty recorded'}
          {doctor.experienceYears !== null ? (
            <> · {doctor.experienceYears} years’ experience</>
          ) : null}
        </p>
        {/*
         * Status in words, never as a colour alone (WCAG 1.4.1). "Retired from
         * this clinic" is the fact a receptionist about to book them needs.
         */}
        <p className="text-muted mt-1 text-[0.8125rem]">{STATUS_WORDS[doctor.status]}</p>
      </div>

      {doctor.registrationNumber !== null ? (
        <div className="text-right">
          <p className="eyebrow text-drape">Registration</p>
          {/* Mono, like the UHID: this is a number read aloud and copied onto a
              prescription, and it is what makes one legal. */}
          <p className="mt-1 font-mono text-[0.9375rem]">{doctor.registrationNumber}</p>
          {doctor.registrationCouncil !== null ? (
            <p className="text-muted mt-1 text-[0.75rem]">{doctor.registrationCouncil}</p>
          ) : null}
          {doctor.registrationValidTill !== null ? (
            <p className="text-muted mt-1 text-[0.75rem]">
              Valid until {doctor.registrationValidTill}
            </p>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

function ReadOnlySpecialties({ doctor }: { doctor: DoctorDetail }) {
  return (
    <DoctorPanel
      title="Specialties"
      note="The classification this doctor is listed under, most specific last."
    >
      {doctor.specialties.length === 0 ? (
        <PanelEmpty>Nothing recorded.</PanelEmpty>
      ) : (
        <ul className="mt-3 space-y-3">
          {doctor.specialties.map((specialty) => (
            <li key={specialty.id}>
              <p className="text-[0.9375rem]">
                {specialty.name}
                {specialty.isPrimary ? <span className="text-muted"> · primary</span> : null}
                {specialty.proficiency !== null ? (
                  <span className="text-muted"> · {specialty.proficiency.toLowerCase()}</span>
                ) : null}
              </p>
              {/* The ancestor chain, so "Structural Heart Disease" reads as part
                  of Cardiology rather than as a free-floating label. */}
              {specialty.ancestors.length > 0 ? (
                <p className="text-muted mt-0.5 text-[0.75rem]">
                  {specialty.ancestors.map((a) => a.name).join(' › ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </DoctorPanel>
  );
}

function ReadOnlyQualifications({ doctor }: { doctor: DoctorDetail }) {
  return (
    <DoctorPanel title="Qualifications">
      {doctor.qualifications.length === 0 ? (
        <PanelEmpty>Nothing recorded.</PanelEmpty>
      ) : (
        <ul className="mt-3 space-y-3">
          {doctor.qualifications.map((qualification) => (
            <li key={qualification.id}>
              <p className="text-[0.9375rem]">{qualification.name}</p>
              <p className="text-muted mt-0.5 text-[0.75rem]">
                {qualification.institute ?? 'Institute not recorded'}
                {qualification.yearOfCompletion !== null
                  ? ` · ${String(qualification.yearOfCompletion)}`
                  : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </DoctorPanel>
  );
}

function ReadOnlyHours({ doctor }: { doctor: DoctorDetail }) {
  return (
    <DoctorPanel title="Working hours" note="What the front desk books against.">
      {doctor.schedules.length === 0 ? (
        <PanelEmpty>No working hours set.</PanelEmpty>
      ) : (
        <ul className="mt-3 space-y-2">
          {doctor.schedules.map((schedule) => (
            <li key={schedule.id} className="text-[0.9375rem]">
              <span className="inline-block w-24">{DAYS[schedule.dayOfWeek] ?? 'Unknown'}</span>
              <span className="font-mono text-[0.8125rem]">
                {clockTime(schedule.startTime)}–{clockTime(schedule.endTime)}
              </span>
              <span className="text-muted text-[0.75rem]">
                {' · '}
                {schedule.branchName}
                {/* `effectiveSlotMinutes`, not `slotMinutes` — the latter is null
                    when the block inherits from the settings ladder, and "null
                    min slots" is what a raw read renders (ADR-0015). */}
                {' · '}
                {schedule.effectiveSlotMinutes} min slots
                {!schedule.isActive ? ' · not in use' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </DoctorPanel>
  );
}
