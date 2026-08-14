# Follow-up architecture: chain, episode, recommendation

Three different questions, three different mechanisms. Conflating any two of
them is the mistake this document exists to prevent.

```text
"What visit did this one come from?"        →  appointments.parent_appointment_id
"What treatment journey is this part of?"   →  appointments.clinical_episode_id
"What did the doctor ASK the patient to do?"→  encounter_follow_up_recommendations
```

The first two are facts about bookings. The third is a clinical instruction,
and it is true whether or not anybody ever books anything.

---

## 1. The chain — already built, do not rebuild it

`appointments.parent_appointment_id` exists today, is composite-FK'd to
`(organization_id, id)` with `onDelete: Restrict`, and is indexed as
`[organizationId, parentAppointmentId]`.

```text
1 Aug   Appointment A   NEW         parent = NULL
25 Aug  Appointment B   FOLLOW_UP   parent = A
 4 Sep  Appointment C   FOLLOW_UP   parent = B      ← B, not A
```

`createFollowUp(parentAppointmentId, …)` writes `parentAppointmentId: parent.id`
from whichever appointment the booking was made from, so C already points at B
and never at A. **The required semantics hold in the code as shipped.**

### ⚠️ The column is `parent_appointment_id`, not `follow_up_of_appointment_id`

The brief offered "`follow_up_of_appointment_id` **or the equivalent naming
convention already used in the project**". The project's is
`parentAppointmentId`, and it is load-bearing in:

- `appointment-billing.service.ts` — the free-review window
- `packages/contracts/src/appointments.ts` — `AppointmentDetail`
- the appointment detail page and the day board
- `appointments.test.ts` and the tenant-isolation suite

Renaming is a wide diff that changes no behaviour. **Keep `parentAppointmentId`.
The two names mean the same thing; this file is the record of that.**

### What the chain already guarantees

| Guarantee                                          | Enforced by                                                   |
| -------------------------------------------------- | ------------------------------------------------------------- |
| A follow-up cannot cite a parent in another tenant | Composite FK `(organization_id, parent_appointment_id)`       |
| Deleting a visit that has follow-ups is refused    | `onDelete: Restrict` + a count check in the service           |
| The follow-up gets its OWN appointment number      | `issueNumber` from the branch counter — never reused          |
| Patient and branch are inherited, never accepted   | `createFollowUp` reads them off the parent                    |
| Billing knows it is a review                       | `parentAppointmentId !== null \|\| visitType === 'FOLLOW_UP'` |

---

## 2. The episode — new

`clinical_episodes` groups every appointment in one continuous treatment
journey. `appointments.clinical_episode_id` joins them.

```text
Clinical episode  "Androgenetic alopecia — management"
  ├── A  1 Aug   NEW
  ├── B 25 Aug   FOLLOW_UP   parent = A
  └── C  4 Sep   FOLLOW_UP   parent = B
```

### Why an episode is not just "walk the chain to the root"

Three reasons, and the third is the one that decides it:

1. **A walk is O(depth) and recursive.** "Show me this journey" becomes a
   recursive CTE on every render. `clinical_episode_id` makes it one indexed
   equality.
2. **A journey can branch.** A patient sent from the dermatologist to the
   dermatologic surgeon and back has two chains and one journey.
3. **A journey can start without a chain.** A walk-in with no appointment still
   opens an episode, and a chain rooted at a booking cannot express that.

### Tenancy: org-scoped, NOT branch-scoped

The same call `patients` makes, for the same reason:

> A person is one person across a hospital group. — `enable-rls.sql`

A patient who starts treatment at the main branch and continues at the satellite
has **one** journey. A branch-scoped episode would split it in two and the
second half would be invisible from the first branch.

⚠️ **It is PHI.** An episode title is a clinical statement about a named person
("Androgenetic alopecia — management"). It is in `REDACTED_KEYS`, it never
reaches an audit row, and reads write `data_access_logs` under a new
`CLINICAL_EPISODE` resource.

### Every appointment belongs to exactly one episode

`clinical_episode_id` is **NOT NULL** after the backfill. An episode of one is
the ordinary case — a single acute visit that never repeats is a complete
journey. Nullable would only make "an appointment belonging to no journey"
representable, and nothing should be able to produce that.

**Which episode a new appointment joins:**

```text
booked as a follow-up of X   →  X's episode
booked fresh (NEW / WALK_IN) →  a new episode opens
booked fresh, but the front  →  the chosen episode, when the desk says
desk says "this is about the     "same problem as before" (CE-4 UI;
same thing"                       the API accepts clinicalEpisodeId from CE-1)
```

⚠️ **The default for a fresh booking is a NEW episode, never "the patient's most
recent open one".** Guessing that a sore throat in March belongs to the diabetes
journey from January is a clinical claim the software has no basis for. Joining
an existing episode is always somebody's explicit decision.

### Backward compatibility — the backfill

Existing appointments have no episode. One migration, three steps, in order:

```sql
-- 1. add nullable
ALTER TABLE appointments ADD COLUMN clinical_episode_id uuid;

-- 2. one episode per CHAIN ROOT, then walk down assigning the root's episode.
--    A recursive CTE over parent_appointment_id; every existing row is reachable
--    because a chain cannot cycle (Restrict + no update path creates one).

-- 3. set NOT NULL, then add the composite FK.
```

⚠️ **Step 3 must come after step 2 in the SAME migration.** A deploy that lands
the column and sets NOT NULL in a later migration leaves a window where
`createAppointment` writes NULL and the second migration then fails on live data.

---

## 3. The recommendation — new, and the point of this piece of work

> "Come back after 15 days."

Today that sentence has nowhere to live. The only way to express it is to book
an appointment — which asserts a slot the patient never agreed to, burns an
appointment number from a branch counter a clinic reads as a sequence, and puts
a booking on the day board that nobody is expecting.

So it becomes a row on the encounter:

```text
encounter_follow_up_recommendations
  encounter_id            the consultation that recommended it
  is_required             the doctor may explicitly say "no follow-up needed"
  interval_value          15
  interval_unit           DAYS | WEEKS | MONTHS
  recommended_date        …OR an absolute date. Exactly one of the two.
  follow_up_type          ROUTINE | PROCEDURE_REVIEW | LAB_REVIEW |
                          POST_OPERATIVE | OTHER
  reason                  ⚠️ PHI
  notes                   ⚠️ PHI
  fulfilled_by_appointment_id   NULL until the patient actually books
  fulfilled_at
  cancelled_at / cancelled_reason
```

### The lifecycle

```text
      doctor finalizes the consultation
                  ↓
      RECOMMENDATION exists          fulfilled_by_appointment_id = NULL
                  ↓
      patient books (days later, at the desk, on the phone, online)
                  ↓
      APPOINTMENT created            parent = the recommending appointment
                                     episode = the recommending appointment's
                  ↓
      RECOMMENDATION fulfilled       fulfilled_by_appointment_id = the new id
```

### Why this split earns its table

**It is what makes a recall list possible.** The clinic's real question is
_"who was told to come back and hasn't?"_ — and that question is unanswerable
if a recommendation and a booking are the same row, because an unbooked
recommendation would simply not exist.

```text
recommended, not yet booked, due within 7 days   →  the desk rings them
recommended, overdue                             →  the desk chases
recommended, cancelled                           →  the patient declined; recorded
```

**It is also the honest record.** What the doctor advised is a clinical fact
that stays true whether or not the patient complies. Deriving it from a booking
means a patient who never returns has no record of having been told to.

### Rules

- **Exactly one of `interval_value`+`interval_unit` or `recommended_date`.** A
  CHECK constraint, not a convention. "In 15 days" and "on 4 September" are both
  legitimate and storing both invites them to disagree.
- **`is_required = false` is a real answer** and carries no interval. "No
  follow-up needed" is a clinical decision worth recording, not an absence.
- **A recommendation is immutable once its encounter is finalized**, like every
  other part of the consultation (CD-2). Changing the plan is an amendment.
- **Fulfilment is idempotent and one-to-one.** A partial unique index on
  `fulfilled_by_appointment_id` — one appointment cannot fulfil two
  recommendations, and re-posting the same booking changes nothing.
- **Fulfilment is optional in both directions.** A patient may book a follow-up
  nobody recommended (an appointment with no recommendation), and a
  recommendation may never be fulfilled. Neither is an error.

---

## 4. What the doctor sees when they open a follow-up

Driven entirely by data that now exists — no specialty branching, no guessing:

```text
appointment.parent_appointment_id  →  the previous appointment
  └── its encounter                →  the previous consultation
        ├── diagnoses              →  "Androgenetic alopecia"
        ├── prescriptions          →  "Minoxidil 5% — 1 ml once daily — 30 days"
        ├── investigations         →  "CBC"
        ├── advice                 →  "Hair care routine"
        └── follow_up_recommendation → "30 days"   ← what they were told last time

appointment.clinical_episode_id    →  the whole journey, for the timeline
```

⚠️ **Read-only, always.** The previous consultation is rendered as a summary
with a link to the full record. Nothing on the current consultation screen can
write to it — finalized encounters are immutable (CD-2), so this is enforced by
the storage model and not by the UI hiding a button.

---

## 5. API surface

| Endpoint                                          | Purpose                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /v1/appointments/:id/follow-up`             | **Exists.** Gains `clinicalEpisodeId` inheritance and optional `fulfilsRecommendationId` |
| `GET  /v1/clinical-episodes/:id`                  | The journey: appointments in order, with their encounter summaries                       |
| `GET  /v1/patients/:id/visit-history`             | Every episode for a patient, newest first                                                |
| `GET  /v1/clinical-episodes?patientId=&status=`   | The episode picker at the front desk                                                     |
| `POST /v1/clinical-episodes`                      | Open one explicitly (rare — booking usually does it)                                     |
| `PATCH /v1/clinical-episodes/:id`                 | Retitle, close, reopen                                                                   |
| `GET  /v1/follow-up-recommendations?status=DUE&…` | **The recall list.** Unfulfilled, by due window                                          |

Recommendations are created and amended only as part of the encounter — they
have no create endpoint of their own, because a follow-up plan with no
consultation behind it is not a thing a doctor produces.

---

## 6. What this does NOT change

- No existing column is renamed or dropped.
- `createFollowUp` keeps its signature; it gains episode inheritance and an
  optional recommendation link.
- The billing free-review window keeps reading `parentAppointmentId` and
  `follow_up_free_days`. **Episodes deliberately do not price anything** — a
  journey is a clinical grouping, and letting it decide chargeability would make
  a front-desk grouping decision into a billing decision.
- The day board, the availability engine and the GiST no-overlap constraint are
  untouched.
