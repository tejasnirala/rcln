# Country Rule Pack Survey — PI-13 … PI-21

**A framework-gap survey across all nine remaining jurisdictions, run before any
of their packs was written.** Its question is narrow and deliberately not
"what are this country's rules?":

> Which rule shapes do these nine jurisdictions need that
> `@rcln/regulatory`'s parameter documents cannot express today?

**Date:** 2026-08-19 · **Ran before:** PI-13 · **Countries:** US GB AU SG AE IE
NP LK BD

---

## ⚠️ What this document is NOT

**Not a source of law, and not a step towards one.** Nothing here may be cited
by a `regulatory_rule`, and nothing here moves a cell in
[COUNTRY_SUPPORT_MATRIX.md](COUNTRY_SUPPORT_MATRIX.md). `regulatory_rule.source_id`
is NOT NULL so that every rule traces to a regulator's own publication, and a
survey note is not one.

**Several findings below rest on secondary sources** — regulator guidance pages,
search summaries — because establishing _"does this country express prescription
validity in months?"_ does not require the statute, while **writing the rule
does**. Every pack still begins by reading the primary document, exactly as the
India pack did. Where a finding here is secondary it is marked `[2°]`.

The reason this was worth doing at all is in the [Why](#why-this-ran-first)
section: one country produced two framework gaps in an hour, and the framework
is the shared, high-risk code.

---

## Why this ran first

PI-13's research turned up two statutes that the engine could not express, both
inside the first jurisdiction attempted. Extending `engine.ts` nine times, once
per country, means nine rounds of churn on the one file every jurisdiction
depends on — and each round re-opens the risk of a rule that is configured,
visible, and inert.

So the survey front-loads the part that causes churn (the shapes) and
deliberately skips the part that goes stale (the rules). `retrieved_at` and pack
staleness are first-class in this design because regulations move; researching
nine countries now and writing the ninth pack much later would mean configuring
it from notes rather than from the document.

---

## The findings

### GAP 1 — Validity expressed in calendar months · **4+ of 9** · must fix

`PrescriptionRequiredParameters.validityDays` and
`RefillRuleParameters.validityDays` are day counts. Four jurisdictions state
validity in **calendar months**, which is not a day count and must not be
approximated as one.

| Jurisdiction | Statement                                                   | Source                           |
| ------------ | ----------------------------------------------------------- | -------------------------------- |
| US           | Sch III/IV: "more than six months after the date"           | 21 U.S.C. 829(b) — read directly |
| GB           | POM: 6 months                                               | `[2°]`                           |
| AU           | S4 restricted 12 months; S8 6 months (NSW); App. D 6 months | `[2°]`                           |
| IE           | POM: 6 months                                               | `[2°]`                           |

⚠️ **`180` IS AN INVENTION AND IT FAILS IN THE REFUSING DIRECTION, WHICH IS THE
DIRECTION NOBODY AUDITS.** A prescription written 1 January is lawful to 1 July
— 181 days. `validityDays: 180` would refuse a lawful dispense on day 181 while
citing a statute that permits it, and a refusal that looks correct is one nobody
goes back to check. Six months is not 180 days in any month of the year.

**Fix.** Add `validityMonths` beside `validityDays` on both parameter shapes,
with calendar-month arithmetic in the engine. Both may be present; the earlier
expiry governs. A rule states the one its statute states.

---

### GAP 2 — A precondition established outside the transaction · **3 of 9** · must fix

Three jurisdictions make a supply lawful only if something is **already true**,
where that something was established before the transaction and the person
dispensing can only _verify_ it — never perform it.

| Jurisdiction | The precondition                                                                                                                                               | Source                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| US           | Remote supply of a controlled substance needs a prescriber who has conducted at least one **in-person medical evaluation** (or a covering practitioner)        | 21 U.S.C. 829(e) — read directly |
| AU           | Certain Schedule 8 substances need a **permit/authority from the state health department for that patient** before prescribing                                 | `[2°]`                           |
| AE           | A narcotic must be on the **approved official prescription form**; Abu Dhabi outpatient narcotic supply generally disallowed absent a medical-director request | `[2°]`                           |

⚠️ **WITHOUT A SHAPE FOR THIS, `permitted: true` RETURNS `PERMITTED` IN SILENCE
AND THE STATUTE'S WHOLE CONTENT IS THE PROVISO.** `evaluateOnlineDispensing`
today returns a bare permission when `permitted` is true and no classification is
excluded. For 829(e) that inverts the section: the section does not authorise
internet supply, it conditions it, and a pack that says `permitted: true` with
nothing attached has asserted the opposite of what Congress wrote.

**Fix.** Two new condition kinds, not one generic kind with a discriminator —
matching the existing vocabulary, which is already specific
(`VERIFY_PATIENT_AGE`, `VERIFY_PRESCRIBER_REGISTRATION`):

- `VERIFY_PRIOR_IN_PERSON_EVALUATION` — US 829(e), and likely AU telehealth
- `VERIFY_PRIOR_AUTHORISATION` — AU S8 permit, AE narcotic approval

plus the parameter keys that let a rule ask for them:
`OnlineDispensingParameters.requiresPriorInPersonEvaluation`, and
`priorAuthorisationRequired` / `authorisationAuthority` on
`ControlledScheduleParameters`.

⚠️ **THESE ARE THE FIRST CONDITIONS THE DISPENSER CANNOT DISCHARGE.** Every
existing kind names something they do — write the register, check the age, print
the label. These name a fact about somebody else's diary or a permit in somebody
else's filing cabinet. A screen that renders them as a tick-box is asking a
pharmacist to attest to a thing they cannot see, so the UI treatment is a real
decision and not a detail. Recorded as an open question for whoever builds it.

---

### GAP 3 — Quantity limits expressed as days' supply · **2 of 9** · fix

`QuantityLimitParameters` is denominated in **base units**
(`maxPerTransactionBase`, `maxPerPeriodBase`). Several limits are denominated in
**treatment days**, which is a property of the directions for use, not of the
quantity.

| Jurisdiction | Statement                                                         | Source                            |
| ------------ | ----------------------------------------------------------------- | --------------------------------- |
| US (NY)      | No prescription for a quantity exceeding a **thirty day supply**  | NY PHL § 3332 `[2°]`              |
| US (federal) | Multiple Sch II prescriptions totalling up to a **90-day supply** | 21 CFR 1306.12(b) — read directly |
| GB           | 30 days' supply — **recommendation, not law**, so _no rule_       | `[2°]`                            |

**Fix.** Add `maxDaysSupply` to `QuantityLimitParameters` and an optional
`daysSupply` to the request. Absent where a rule needs it → `UNDETERMINED`,
which refuses — the same treatment `evaluateOnlineDispensing` already gives a
missing destination. The platform frequently will not know the days' supply, and
"we cannot tell" must not read as "permitted".

⚠️ **GB'S 30 DAYS IS GUIDANCE AND GETS NO RULE.** It is a Department of Health
recommendation, and dispensing beyond it is expressly not unlawful. Writing it
as a rule would have this platform refusing supplies that UK law permits.

---

### GAP 4 — Limits denominated in a _contained substance_ · **1 of 9** · do NOT fix now

| Jurisdiction | Statement                                                                                    | Source                              |
| ------------ | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| US           | 3.6 g of pseudoephedrine **base** per purchaser per day, across products measured in tablets | 21 U.S.C. 830(d)(1) — read directly |

The limit is on a quantity of a **chemical contained in** the product, and the
product's base unit is tablets. Answering it needs the composition and strength
— which PI-1.4 does model (`composition_ingredients.strength`) — plus arithmetic
across it.

**Recommendation: leave it out, and leave the rules out with it.** This is
India's NDPS call made again for the same reason: a half-modelled version is
worse than an honest absence. Writing `3.6` against tablets would be badly and
invisibly wrong. The US pack therefore carries **no pseudoephedrine rules**, the
matrix cell stays `RESEARCH_REQUIRED`, and the reason is recorded in the pack's
own data file. Revisit as its own phase, not inside a country pack.

---

### GAP 5 — Sub-national packs are needed more widely than the matrix says · must fix

`PackSeed` in `seed/regulatory-packs.ts` hardcodes `regionCode: null`. **No
schema change is needed** — `jurisdictions.region_code`, the `NULLS NOT
DISTINCT` unique index, and per-rule-type supersession in `selection.ts`
`mostSpecific()` were all built for this in PI-5 and have never been exercised.

| Jurisdiction | Sub-national reality                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| AU           | ⚠️ **Structurally mandatory.** The Poisons Standard is federal but has **no legal force except through state and territory legislation** `[2°]` |
| AE           | Emirate authorities with their own standards and prescription forms — DHA (Dubai), DoH (Abu Dhabi) `[2°]`                                       |
| US           | State pharmacy law; California researched for PI-13                                                                                             |
| GB           | England/Wales/Scotland/NI divergence in some instruments `[2°]`                                                                                 |

⚠️ **AUSTRALIA, NOT THE UNITED STATES, IS THE HARDEST PACK IN THE PROGRAMME, AND
THE PLAN SAYS OTHERWISE.** MASTER_PLAN.md put the US second "because it is the
hardest — federal plus state". That is true of the US, but the US federal pack
is _directly operative_: 21 CFR binds a pharmacy in Nevada whether or not Nevada
legislates. The Poisons Standard binds nobody by itself. An AU pack seeded at
national level and left there would be a pack that correctly describes an
instrument with no legal effect — configured, visible, and inert, which is this
domain's signature failure. **PI-15 must ship at least one state pack or it must
not ship.**

---

## Confirmed non-gaps

Shapes that already work, checked so that nobody re-opens them:

- **CD validity in days** — GB 28, IE 14, AE 3. `validityDays` is correct and
  sufficient. Only the _months_ cases need GAP 1.
- **UK repeatable prescriptions** — "dispensed the number of times stated, and
  twice if no number is stated" is `endorsedRepeatsPermitted` +
  `maxEndorsedRepeats`, both of which exist. PI-7 built exactly this shape for
  India's rule 65(11).
- **Jurisdictional licensure** — AU "authorised prescriber", AE "HAAD-licensed
  physician" are `permittedLicenceTypes`, which already carries the
  licence-not-role-code discipline `RegulatoryActor` warns about.
- **Classification vocabularies** — US Schedules II–V + "Rx only"; GB POM/P/GSL;
  AU S2/S3/S4/S8; AE narcotic/controlled/semi-controlled/POM/OTC; SG poisons
  schedules. All are free-text `appliesToClassification`, matched exactly. No
  change.

---

## Source availability — a sequencing risk, not an architecture one

| Access       | Jurisdictions      | Notes                                                                                                                                                                                                             |
| ------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Good**     | US, IE, SG, AU, NP | eCFR has a JSON/XML API and govinfo serves the US Code; irishstatutebook.ie, sso.agc.gov.sg, legislation.gov.au all serve text; Nepal's DDA publishes the Drugs Act 2035 in English                               |
| **Degraded** | GB                 | legislation.gov.uk returned `202` on every attempt, HTML and XML alike, and rendered empty through the fetch proxy. **PI-14 needs an access route found before it starts** — the published PDFs are one candidate |
| **At risk**  | LK, BD             | Sri Lanka's NMRA publishes mostly _registration_ material rather than dispensing rules; Bangladesh's DGDA returned nothing at all                                                                                 |

⚠️ **PREDICT THE THIN PACKS NOW RATHER THAN DISCOVERING THEM AT PI-21.** If
Sri Lanka and Bangladesh publish licensing and registration law but not
dispensing law, their packs are correctly **mostly `RESEARCH_REQUIRED`** — which
is a result, not a failure, and is exactly what India's own matrix cells already
demonstrate. What must not happen is those phases inventing plausible rules to
look complete.

---

## What this changes about the plan

**PI-13 gains a framework sub-phase, and it runs once for all nine.**

| Phase      | Change                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **PI-13a** | **New.** Framework extensions sized to all nine: GAP 1, GAP 2, GAP 3, GAP 5. Tested against the synthetic `ZQ` packs in `packages/regulatory/tests/engine.test.ts`, where every rule type is tested. No country's rules. |
| PI-13      | US federal + California state pack. Unchanged in scope, now built on PI-13a                                                                                                                                              |
| PI-14 GB   | ⚠️ **Blocked until an access route to legislation.gov.uk is found**                                                                                                                                                      |
| PI-15 AU   | ⚠️ **Re-sized S → M.** Must ship a federal pack _and_ at least one state pack                                                                                                                                            |
| PI-16 SG   | Unchanged                                                                                                                                                                                                                |
| PI-17 AE   | ⚠️ **Re-sized S → M.** Federal + at least one emirate                                                                                                                                                                    |
| PI-18 IE   | Unchanged                                                                                                                                                                                                                |
| PI-19..21  | NP, LK, BD — batchable, and expected to land thin. Not a defect                                                                                                                                                          |

**Nothing here needs a migration.** Five gaps, four of them fixed in
`@rcln/regulatory` and the seed, none of them in the database. That is the
strongest evidence available that the PI-5 design was right: the schema absorbed
nine jurisdictions of survey without moving.

---

## Open questions this raised

- **OD — who decides the UI for a condition the dispenser cannot discharge?**
  `VERIFY_PRIOR_IN_PERSON_EVALUATION` and `VERIFY_PRIOR_AUTHORISATION` are
  obligations nobody at the counter can fulfil. Rendering them as tick-boxes
  makes a pharmacist attest to somebody else's record. → [OPEN_DECISIONS.md](OPEN_DECISIONS.md)
- **Does GAP 3's `daysSupply` have any caller that can supply it?** If no call
  site can compute treatment days from the directions, every rule using it
  answers `UNDETERMINED` and refuses — correct, but it makes the NY-style rules
  unusable in practice rather than merely strict.
- **Contained-substance limits (GAP 4)** need a phase of their own if any
  jurisdiction's pack is ever to be complete. None is proposed yet.
