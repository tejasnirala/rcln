# ADR-0018 — The clinic profile seeds settings; it does not replace them

**Status:** Accepted

## Context

Registration creates an organization, a domain, a first branch and an owner in
one transaction, and then drops that owner into a product where every module is
visible and nothing is configured. `register.service.ts` is the whole of what we
know about a clinic when it starts: a name, a country, a subdomain.

But a clinic's identity is knowable once, at the beginning, and is then wanted by
a dozen screens. Whether it treats people or animals decides what a patient
record defaults to and whether the front desk is asked at all. Whether it runs a
pharmacy decides half the navigation. When it opens decides the calendar. None of
that is derivable from anything, and today the answer is that somebody finds the
settings screen and works it out.

There is already a substrate for this. `setting_definitions` and `setting_values`
resolve `USER → DOCTOR → BRANCH → ORGANIZATION → PLATFORM → default`, most
specific wins (`resolver.service.ts`), and the entire premise of that pair is
that adding a knob is an INSERT rather than a migration. There is also already a
vocabulary for "human or animal": `CARE_CONTEXT` sits at the root of the specialty
taxonomy above `DOMAIN` (CE-1), and consultation templates, visual maps and
clinical vocabulary already resolve by walking a classification up to it.

So the question is not what to store. It is **what the stored answer is allowed to
do afterwards**.

## Decision

Onboarding writes a `clinic_profiles` row recording who this clinic is, and from
it **seeds concrete `setting_values` rows — once, idempotently, and only where no
explicit value exists at that scope**. Afterwards the clinic owns those settings
and the settings screen is the authority on them.

Five consequences follow, and they are the decision:

1. **The profile is read at request time for exactly two things**: whether a
   navigation tab is drawn, and whether the patient form shows a care-context
   picker. Everything else the wizard captured is a setting row.

2. **`branch_id` is nullable on the profile, and NULL means the organization's
   answer.** The `membership_roles` shape (ADR-0002), reused deliberately, so
   resolution is BRANCH-over-ORGANIZATION exactly as `setting_values` resolves it.
   A hospital whose satellite is a standalone pharmacy is a second row, not a
   second table. It requires a `NULLS NOT DISTINCT` rewrite of the unique index,
   which `specialties` already needs for the same reason.

3. **Care contexts are rows of `specialties` at `CARE_CONTEXT` level**, not a new
   enum — so templates, charts and clinical vocabulary follow along for free.

4. **Modules are gated by `plan_features` and picked by the profile.** Three
   different questions share one vocabulary: what the clinic MAY have, what it
   PICKED, and WHO may touch it. An unentitled module is refused with a **400** —
   not a 403, which is a statement about the caller, and not a 422, which on this
   API means a jurisdiction refused something and carries rule codes.

5. **The profile is never an authorization input.** Hiding a tab is UX;
   `authorize()` still decides and still refuses. A clinic that ticks a module box
   grants nobody anything.

`organizations.onboarded_at` is renamed `registered_at` in the same migration,
because that is what it has always held.

## Alternatives rejected

**Wide columns on `organizations`.** Every new fact is a migration, and none of
them can be overridden per branch. It is the shape ADR-0001 already rejected for
tenancy itself.

**A JSONB profile document.** Tempting and wrong twice: care contexts are foreign
keys and ADR-0006 forbids JSON arrays of ids; and a document cannot be resolved
branch-over-organization without re-implementing the resolver beside it.

**Read the profile at request time AS the configuration.** This is the seductive
one, and rejecting it is most of what this ADR is for. It halves the write path
and it breaks the settings screen permanently: the clinic changes
`locale.time_format` in Settings, the profile still says otherwise, and one
question has two answers with nothing to arbitrate between them. It also makes
re-onboarding destructive — re-entering the pharmacy step in year two would
silently revert every value the clinic had tuned since.

**Read the profile to resolve consultation templates.** Proposed and dropped
during design. `consultation-config.service.ts` already resolves the care context
from `patients.subject_type`, per patient — a pet clinic's templates are correct
because its patients are ANIMAL. A profile read there would be a second,
contradictable answer, and it would break a mixed practice's one human patient.

**Modules as permissions.** Would make "we do not run a pharmacy" indistinguishable
from "you may not dispense", and a configuration edit would become a privilege
escalation.

**Reuse `organizations.onboarded_at` for completion.** It is set by
`register.service.ts` inside the registration transaction, so it has always meant
REGISTERED. Reusing it would have read every clinic already on the platform as
fully onboarded — a silent wrong answer of exactly the kind this codebase keeps
producing.

**Block everyone until setup is done.** A clinic is often already seeing patients
when it starts using rcln, and its receptionist logs in before its owner does.
The redirect is gated on `organization.onboarding.write`; everybody else gets a
banner and a working app.

## Consequences

Two reads exist where one might have — the profile for shape, settings for
values. Accepted: they answer different questions, and collapsing them is the
alternative rejected above.

Re-onboarding is safe and idempotent by construction, so "add a pharmacy in year
two" is one step re-entered rather than a support ticket.

Every existing organization reads as not onboarded and its owner walks the wizard
once, against a form pre-filled from what registration already knows. **No profile
row is backfilled**, deliberately: that is the honest state, and it is the same
code path a brand new clinic takes, so it is exercised by definition.

Adding a module later costs an enum value, a nav entry and — if it is sold
separately — a `plan_features` key. It never costs a schema change to the profile.

Two join tables carry a copy of their parent's `branch_id` so the generic branch
policy has a column to name. The database cannot check that the copy is faithful:
a composite FK over a nullable column is MATCH SIMPLE and skips the check when
the column is NULL. The service writes both halves in one transaction and the
isolation suite asserts they agree; there is no third guard short of a trigger.

`setting_values` is RLS-exempt, so the seeder is the most dangerous code in the
feature and `db:rls:check` structurally cannot cover it — there is no policy to be
missing. Its pinned `(setting_key, scope_type, scope_id)` predicates are the
isolation, and an integration case asserts that one clinic's wizard leaves
another's settings untouched.
