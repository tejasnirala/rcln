# Country Support Matrix

A living document. **A regulatory cell stays `RESEARCH_REQUIRED` until a real
source is found, read and recorded** in `regulatory_sources`. India is the first
country where some of them have moved; every other country's are untouched.

**Last updated:** 2026-08-24 · **India, the United States, Australia, Singapore,
the United Arab Emirates, Ireland and Bangladesh at `AUTOMATED_TESTED`; every
other row at `ARCHITECTURE_SUPPORTED`**

⚠️ **PI-21 SEEDED `BD 1.0.0` — 56 RULES, 4 SOURCES — AND IT IS THE FIRST PACK IN
THIS PROGRAMME WHOSE AUTHENTIC TEXT IS NOT ENGLISH.** Section 83(2) of the ঔষধ ও
কসমেটিকস্ আইন, ২০২৩ and section 70(2) of the মাদকদ্রব্য নিয়ন্ত্রণ আইন, ২০১৮ each
provide that where the Bangla and English texts conflict, the **Bangla text
prevails**. Every rule was read off the Bangla on bdlaws.minlaw.gov.bd; the
English in a rule statement is the pack's rendering, not an authority's, and the
commercial translations that circulate were refused. ⚠️ **`SOURCE_VERIFIED` FOR
`BD` THEREFORE MEANS SOMETHING DIFFERENT FROM WHAT IT MEANS FOR `IE` OR `US`: it
cannot be closed by anybody who does not read Bangla.**

⚠️ **AND THE ROW BELOW WAS WRONG ON BOTH COUNTS BEFORE PI-21 RAN.** The survey
rated Bangladesh "at risk — the DGDA returned nothing at all" and predicted a
thin pack. `dgda.gov.bd` responds today (only `www.dgda.gov.bd` does not
resolve), serving eight instruments including the full Bengal Drugs Rules 1946
and an Online Pharmacy licence guideline. And Bangladesh **replaced its medicines
Act in 2023**: Act 29 of 2023 repealed both the Drugs Act, 1940 and the Drugs
(Control) Ordinance, 1982 outright, so every secondary description of Bangladeshi
drug law older than September 2023 — including this file's own note — describes
repealed statutes. Re-check a source before believing a survey about it.

⚠️ **PI-18 SEEDED `IE 1.0.0` — 40 RULES, 7 SOURCES — AND IT IS THE FIRST PACK IN
THIS PROGRAMME THAT FORBIDS REMOTE SUPPLY RATHER THAN CONDITIONING IT.**
Regulation 19(1) of the Medicinal Products (Prescription and Control of Supply)
Regulations 2003 prohibits mail order of any medicinal product; regulation 19(5),
inserted in 2015, extends that to information society services; and regulation
19A(8)(b) says nothing in the permission for non-prescription distance selling
authorises sending a prescription medicine to a person in the State. Every
prescription-controlled classification in the pack therefore carries
`ONLINE_DISPENSING` with `permitted: false`, which REFUSES.

⚠️ **AND IRELAND IS THE FIRST COUNTRY WHOSE EMPTY `CountryInfo.regions` IS
CORRECT.** Australia's cost PI-15 a working pack and the UAE's cost PI-17 two.
Irish medicines and misuse-of-drugs law is made by the Minister for Health for
the whole State, so no sub-national pack can exist to be made inert. The check
was still run, and it found one loose end: `labels.region` for `IE` says
'County', and no county can be selected. Recorded in KNOWN_ISSUES.

⚠️ **FOUR JURISDICTIONS ARE CONFIGURED: INDIA, THE UNITED STATES, AUSTRALIA AND
SINGAPORE.** PI-15 seeded `AU 1.0.0` + `AU-VIC 1.0.0` from the Federal Register's
own text of the Poisons Standard and the Chief Parliamentary Counsel's
consolidation of the Victorian regulations; PI-16 seeded `SG 1.0.0` — 28 rules —
from Singapore Statutes Online. PI-6 seeded
`IN 1.0.0` — 3 sources, 22 rules — from CDSCO's own consolidated Drugs Rules,
1945 and the Pharmacy Act, 1948 on India Code. PI-13 seeded `US 1.0.0` — 7
sources — from eCFR's own XML of 21 CFR 1301/1304/1306/201.105 and GPO's
publication of 21 U.S.C. 353, 829 and 830, **and `US-CA 1.0.0`, the programme's
first sub-national pack**, from the California Legislature's own publication of
the Business and Professions Code. **Every other country still has no
`regulatory_rule_packs` row at all**, so every evaluation elsewhere answers
`UNDETERMINED`, which refuses.

⚠️ **`US-CA` IS NOT CALIFORNIA'S PHARMACY LAW AND MUST NOT BE READ AS IT.** It is
the three places California differs from or adds to federal law in a way this
framework can express — a three-year retention against the federal two, a longer
container label, and generic substitution, which federal law does not regulate.
A regional pack supersedes the national one PER RULE TYPE, so every federal rule
of a type absent from `US-CA` still governs in California.

⚠️ **AND MOST OF INDIA'S OWN CELLS ARE STILL `RESEARCH_REQUIRED`, DELIBERATELY.**
A configured pack is not a complete one. NDPS, quantity limits, age restrictions
and the e-pharmacy position were all researched and NOT written, each for a
reason recorded in `seed/data/regulatory-in.ts`. A cell below moves only when a
rule exists that a source supports.

⚠️ **`AUTOMATED_TESTED` IS NOT `PRODUCTION_ENABLED`, AND THE GAP IS THREE RUNGS
WIDE.** India's sources are `UNVERIFIED` and no qualified person has read the
pack. Goods receipt and transfer DO consult it while posting, but **nothing
blocks**: enforcement is gated on `PRODUCTION_ENABLED`, which only a named human
may set. Nothing here is a claim of compliance.

## Vocabulary

```
SUPPORTED           the platform does this today, verified
RESEARCH_REQUIRED   nobody has established the answer yet
UNKNOWN             researched and still unclear; needs a specialist
NOT_APPLICABLE      the concept does not exist in this jurisdiction
PLANNED             scheduled in a named phase
```

> ⚠️ **Do not fill an unknown cell with a plausible answer.** A confident wrong
> regulatory value is worse than a blank one, because nobody goes back to check
> it. This applies to every agent that touches this file.

---

## Programme-level status

| Country              | ISO | Rule pack phase | Maturity                 | Tax scheme (existing engine) | Sub-national tax                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | --- | --------------- | ------------------------ | ---------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| India                | IN  | PI-6            | `AUTOMATED_TESTED`       | GST                          | ✅ state — `INTRA_STATE_HALVES` split already implemented | **Configured.** Pack `IN 1.0.0`, 22 rules, 3 sources. No sub-national pack; no NDPS. See the dimension table below for what is still open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| United States        | US  | PI-13           | `AUTOMATED_TESTED`       | SALES_TAX                    | ✅ state/county/city/district                             | **Configured.** `US 1.0.0` federal + `US-CA 1.0.0`, the first sub-national pack. Tax still requires the `TaxProviderQuote` seam; the engine already answers `PROVIDER_REQUIRED` rather than guessing a rate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| United Kingdom       | GB  | PI-14           | `ARCHITECTURE_SUPPORTED` | VAT                          | Possible — some instruments are England/Wales/Scotland    | ⚠️ **BLOCKED.** legislation.gov.uk returned `202` on every attempt, HTML and XML alike. An access route is needed before PI-14 opens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Australia            | AU  | PI-15           | `AUTOMATED_TESTED`       | GST                          | ⚠️ **State/territory — structurally mandatory**           | **Configured.** `AU 1.0.0` (4 rules — the Poisons Standard recommends and binds nobody) + `AU-VIC 1.0.0` (18 rules), the second sub-national pack. NSW was the first choice and legislation.nsw.gov.au returns `403`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Singapore            | SG  | PI-16           | `AUTOMATED_TESTED`       | GST                          | ✖ — a city-state, and `regions` is correctly empty        | **Configured.** `SG 1.0.0`, 28 rules, 3 sources, from Singapore Statutes Online. Two vocabularies in one pack: HSA's prescription-only/pharmacy-only and the Misuse of Drugs Regulations' Schedules. ⚠️ No pharmacist-only rule — the gate is conditional on the premises' licence, which rcln does not hold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| United Arab Emirates | AE  | PI-17           | `AUTOMATED_TESTED`       | VAT                          | ⚠️ **Emirate — confirmed, not merely likely**             | **Configured, sub-nationally only.** `AE-AZ 1.0.0` (25 rules, DoH Abu Dhabi) + `AE-DU 1.0.0` (26 rules, DHA Dubai). ⚠️ **NO FEDERAL PACK** — uaelegislation.gov.ae returns `403` and mohap.gov.ae resets the connection, so the Ministerial Decrees both emirates cite were read only as restatements. The other five emirates answer `UNDETERMINED`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Ireland              | IE  | PI-18           | `AUTOMATED_TESTED`       | VAT                          | ✖ — and correctly so: medicines law is national           | **Configured.** `IE 1.0.0`, 50 rules, 7 sources, from the electronic Irish Statute Book. ⚠️ **THE FIRST PACK THAT FORBIDS REMOTE SUPPLY** — reg. 19 of S.I. 540/2003 prohibits mail order and reg. 19A(8)(b) shuts the door on an information society service, so every prescription classification carries `permitted: false`. ⚠️ The twelve-month validity extension of reg. 7(5)(a)(ii) is NOT configured; no Part C classification (hospital-only needs `branch.licence_type`); no FMD traceability rule (eur-lex unreachable).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Nepal                | NP  | PI-19           | `ARCHITECTURE_SUPPORTED` | VAT                          | RESEARCH_REQUIRED                                         | ⚠️ **DEFERRED** — skipped on 2026-08-24 in favour of PI-21. Sources rated good: the DDA publishes the Drugs Act 2035 in English.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Sri Lanka            | LK  | PI-20           | `ARCHITECTURE_SUPPORTED` | VAT                          | RESEARCH_REQUIRED                                         | ⚠️ **DEFERRED** — skipped on 2026-08-24 in favour of PI-21. Source risk: the NMRA publishes mostly registration material, not dispensing rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Bangladesh           | BD  | PI-21           | `AUTOMATED_TESTED`       | VAT                          | ✖ — and correctly so: medicines law is national           | **Configured.** `BD 1.0.0`, 56 rules, 4 sources, read in Bangla from bdlaws.minlaw.gov.bd and from DGDA's own publications. Section 40(ঘ) of the ঔষধ ও কসমেটিকস্ আইন, ২০২৩ is the prescription rule; section 45(1) admits three grades of Council registrant at the counter and DGDA's Online Pharmacy Criteria admit Grade A alone online; the Bengal Drugs Rules 1946 supply the registers, Schedule G's repeats, the Schedule D cupboard and label, and Schedule C's storage; the মাদকদ্রব্য নিয়ন্ত্রণ আইন, ২০১৮ supplies the three narcotic classes. ⚠️ **NO PRESCRIPTION VALIDITY AND NO GENERAL REPEAT RULE — Bangladeshi law states neither**, so a prescription is good forever and for any number of supplies. ⚠️ No general dispensing label (rule 53(2) disapplies the labelling part). ⚠️ A veterinary prescription is refused for an ordinary medicine and accepted for a narcotic, because the 2018 Act defines চিকিৎসক and the 2023 Act does not. ⚠️ The 1946 Rules as DGDA publishes them stop at December 1952. |

The "tax scheme" column reflects which `TaxScheme` member the **existing**
`@rcln/tax` would use. It is a statement about the engine's vocabulary, **not** a
statement about any country's tax law, and it does not mean rates are
configured. Rates come from `tax_rules` / `tax_rule_defaults`, which are empty
for every country except what a clinic configures for itself.

---

## Regulatory dimensions

The table exists so that research has a shape, and so that a partially-researched
country is visibly partial. India is exactly that: some cells sourced, most not.

| Dimension                             | IN         | US         | GB  | AU         | SG         | AE         | IE  | NP  | LK  | BD  |
| ------------------------------------- | ---------- | ---------- | --- | ---------- | ---------- | ---------- | --- | --- | --- | --- |
| Regulatory authority                  | SUP        | SUP        | RR  | SUP        | SUP        | SUP        | RR  | RR  | RR  | RR  |
| Product registration requirement      | RR         | RR         | RR  | RR         | RR         | RR         | RR  | RR  | RR  | RR  |
| National product identifier scheme    | RR         | RR         | RR  | RR         | RR         | RR         | RR  | RR  | RR  | RR  |
| Prescription classification scheme    | SUP        | SUP        | RR  | SUP        | SUP        | SUP        | RR  | RR  | RR  | RR  |
| Controlled-substance scheduling       | RR         | SUP        | RR  | SUP        | SUP        | SUP        | RR  | RR  | RR  | RR  |
| Dispensing restrictions               | SUP        | SUP        | RR  | SUP        | SUP        | SUP        | RR  | RR  | RR  | RR  |
| Pharmacy licensing                    | RR         | RR         | RR  | RR         | RR         | RR         | RR  | RR  | RR  | RR  |
| Pharmacist qualification requirements | SUP        | SUP        | RR  | SUP        | RR         | RR         | RR  | RR  | RR  | RR  |
| Generic substitution rules            | SUP        | SUP        | RR  | SUP        | RR         | RR         | RR  | RR  | RR  | RR  |
| Quantity / refill limits              | RR         | SUP        | RR  | RR         | SUP        | SUP        | RR  | RR  | RR  | RR  |
| Age restrictions                      | RR         | SUP        | RR  | RR         | RR         | RR         | RR  | RR  | RR  | RR  |
| Online pharmacy permitted             | UNK        | SUP        | RR  | RR         | RR         | RR         | RR  | RR  | RR  | RR  |
| Traceability / serialisation mandate  | RR         | RR         | RR  | RR         | RR         | RR         | RR  | RR  | RR  | RR  |
| Batch/lot recording requirements      | RR         | RR         | RR  | RR         | RR         | RR         | RR  | RR  | RR  | RR  |
| Expiry handling requirements          | RR         | RR         | RR  | RR         | RR         | RR         | RR  | RR  | RR  | RR  |
| Storage / cold chain requirements     | RR         | SUP        | RR  | SUP        | SUP        | SUP        | RR  | RR  | RR  | RR  |
| Labelling requirements                | SUP        | SUP        | RR  | RR         | SUP        | RR         | RR  | RR  | RR  | RR  |
| Recall procedure and obligations      | RR         | RR         | RR  | RR         | RR         | RR         | RR  | RR  | RR  | RR  |
| Record retention period               | SUP        | SUP        | RR  | SUP        | SUP        | SUP        | RR  | RR  | RR  | RR  |
| Reporting obligations                 | RR         | RR         | RR  | SUP        | RR         | SUP        | RR  | RR  | RR  | RR  |
| Veterinary-specific rules             | SUP        | SUP        | RR  | RR         | RR         | RR         | RR  | RR  | RR  | RR  |
| Sub-national variation exists         | RR         | SUP        | RR  | SUP        | NA         | SUP        | RR  | RR  | RR  | RR  |
| External system integration required  | RR         | RR         | RR  | SUP        | RR         | SUP        | RR  | RR  | RR  | RR  |
| Source references recorded            | ✅         | ✅         | ✖   | ✅         | ✅         | ✅         | ✖   | ✖   | ✖   | ✖   |
| Last reviewed                         | 2026-08-13 | 2026-08-19 | —   | 2026-08-20 | 2026-08-20 | 2026-08-20 | —   | —   | —   | —   |

`RR` = `RESEARCH_REQUIRED` · `SUP` = `SUPPORTED` · `UNK` = `UNKNOWN` · `NA` =
`NOT_APPLICABLE`.

### Why the United Arab Emirates' remaining cells did not move

⚠️ **Each was researched in PI-17 and left alone on purpose.**

- **Prescription classification scheme — `SUP`, with a caveat worth reading.**
  The six dispensing modes (OTC, Pharmacist only, POM, Semi Controlled,
  Controlled, Narcotic) are MOHAP's and are assigned federally when a medicine is
  registered, which is why both emirate packs share one `AE_CLASSIFICATIONS`.
  ⚠️ The two regulators use different words for the middle tier — Abu Dhabi says
  "psychotropic", Dubai says "controlled drug" — and `CONTROLLED_DRUG` is the one
  string both packs match.
- **Pharmacist qualification requirements — `RR`.** Neither document says who may
  hand a product over; both regulate who may PRESCRIBE it and leave dispensing to
  facility licensing. Neither pack carries a `PHARMACIST_AUTHORITY` rule.
- **Labelling requirements — `RR`.** Abu Dhabi's standard is narcotics-only and
  has none. Dubai's eleven-field label at 13.3.2 is written as a recommendation,
  and a `LABEL_FIELDS` condition is an obligation rather than advice.
- **Quantity limits — `RR`, while refills are `SUP`.** The refill ceilings are
  carried. The days'-supply ladder is not: it turns on the prescriber's grade,
  which no rule shape holds, and nothing populates `daysSupply`. See KNOWN_ISSUES.
- **Age restrictions, generic substitution, online pharmacy, veterinary rules —
  `RR`.** Nothing found in either document.
- **Product registration — `RR`.** It is MOHAP's, and MOHAP is unreachable.

### Why Singapore's remaining cells did not move

⚠️ **Each was researched in PI-16 and left alone on purpose.**

- **Pharmacist qualification requirements — `RR`.** The pack DOES name who may
  supply a controlled drug (regs 7(2), 8(2), 8A of the Misuse of Drugs
  Regulations) and deliberately does NOT name who may supply a prescription-only
  or pharmacy-only medicine. Regulation 3 of the Licensing of Retail Pharmacies
  Regulations imposes an in-store pharmaceutical officer and then disapplies
  itself, in reg 3(3), to a healthcare service licensee or a practitioner
  supplying their own patient — so the answer turns on what the premises are
  licensed as, which rcln does not hold. Half the dimension is supported and
  half is not, and `SUP` would claim both.
- **Generic substitution — `RR`.** Nothing found in either instrument regulates
  it. Absence of a prohibition is not a permission to configure.
- **Age restrictions — `RR`.** Regulation 3(2)(b)(iv) of the Licensing of Retail
  Pharmacies Regulations makes a minimum age turn on HSA's published _list of
  prescription-only medicines exempted for limited sale and supply_, which is a
  website list rather than a provision, and was not retrieved.
- **Online pharmacy — `RR`.** Neither instrument says whether remote supply is
  permitted. Reg 17(1)(b)(iv) contemplates dispensing "by delivery", but it is a
  labelling provision, and inferring an authorisation from what must be printed
  on a box is the step this programme refuses to take.
- **Veterinary-specific rules — `RR`.** The Misuse of Drugs Regulations name a
  veterinary surgeon as a prescriber and the Therapeutic Products Regulations do
  not, which is recorded in the pack — but veterinary medicines in Singapore are
  the Animals and Birds Act's subject and it was not read.
- **Reporting obligations — `RR`.** Regulation 19's addict notification is real
  and attaches to ATTENDING A PATIENT, not to supplying a product. There is no
  transaction for the engine to hang it on.

### Why the United States' remaining cells did not move

⚠️ **Each was researched in PI-13 and left alone on purpose.**

- **Traceability / serialisation mandate — `RR`.** The DSCSA (21 U.S.C.
  360eee-1) imposes real product-tracing obligations on dispensers, and it could
  not be retrieved from any primary source reachable in this pass — govinfo
  returned 404 for every granule path tried. **No source, no rule.** This is the
  single largest known gap in the US pack and a reviewer with access should
  close it.
- **Product registration requirement, national product identifier — `RR`.**
  NDC codes and FDA approval are real and were not researched; PI-13 scoped to
  the supply of a product rather than to its registration.
- **Pharmacy licensing — `RR`.** Licensing a pharmacy is state law in the United
  States, fifty times over. `US-CA` licenses nothing; it carries three
  substantive rules.
- **Reporting obligations — `RR`.** California's CURES database is the obvious
  first one and its cadence could not be read from a primary source. Written as
  no rule rather than a guessed one.
- **Recall procedure, expiry handling, import restriction — `RR`.** Not
  researched.

⚠️ **AND ONE CELL MOVED TO `SUP` ON A NARROWER BASIS THAN IT LOOKS.**
_Quantity / refill limits_ is `SUP` because the refill rules are configured and
the exempt-narcotic dosage-unit caps are — **not** because quantity limits are
complete. 21 U.S.C. 830(d)(1)'s 3.6 g pseudoephedrine cap is **not** written:
it is denominated in a chemical contained in the product while the product's
base unit is tablets, and this platform does no composition arithmetic. The
volumetric limbs of 21 CFR 1306.26(b) are not written either, for the same
reason. See COUNTRY_RULE_PACK_SURVEY.md, GAP 4.

### Why Australia's remaining cells did not move

⚠️ **Each was researched in PI-15 and left alone on purpose. Read the AU column
against the fact that the national instrument binds nobody** — eleven cells are
`SUP` and nine of them are `SUP` because **Victoria** says so, not because
Australia does.

- **Labelling requirements — `RR`, and this is the one that looks wrong.**
  Victoria's reg 72 _is_ configured and tested, so a cell could be argued. It is
  not, because reg 72 is a **supplementary** requirement that adds two fields to
  whatever the national dispensing label already demands — and the national one
  is Appendix L to the Poisons Standard, whose text could not be retrieved (the
  instrument's HTML truncates before the appendices; its PDF is thousands of
  pages of substance listings). A screen driven by `LABEL_FIELDS` today would
  print a container missing the patient's name. `SUP` would say the opposite.
- **Quantity / refill limits — `RR`.** Neither instrument sets a refill
  allowance this framework can express. Reg 51(2) caps a Schedule 8 supply at
  two days' treatment **unless** the pharmacist verifies the prescriber, and the
  framework models a bar, not a bar-with-a-discharge — the same inverted default
  California's `requiresPrescriberConsent` hit. Written into the rule statement
  instead of into a parameter.
- **Veterinary-specific rules — `RR`.** Reg 72(a) requires an animal's species,
  age, breed and sex and its owner's name on the container. Those are
  conditional on the patient and `fields` is unconditional, so they sit in
  `detail` text a pharmacist reads and a screen cannot enforce.
- **Traceability, batch/lot, expiry, recall, pharmacy licensing, product
  registration, national identifier — `RR`.** Not researched; PI-15 scoped to
  the supply of a product.
- **Age restrictions, online pharmacy — `RR`.** Nothing found in either
  instrument. Absence of a rule here is "not researched", never "no restriction
  exists".

⚠️ **AND ONE CELL IS `SUP` ON A NARROWER BASIS THAN IT LOOKS.** _Reporting
obligations_ is `SUP` because SafeScript is configured for **Schedule 8**, which
Schedule 6 to the Victorian Regulations makes monitored in its entirety. Schedule
6 also names benzodiazepines, codeine, gabapentin, pregabalin, quetiapine,
tramadol, zolpidem and zopiclone — individual **substances inside** Schedule 4,
which `appliesToClassification` cannot express. Those are not reported by this
pack.

---

### Why India's remaining cells did not move

⚠️ **Each of these was researched and left alone on purpose.** A cell that stays
`RR` after a research session is a result, not an omission.

- **Controlled-substance scheduling — `RR`.** Schedule H1 and Schedule X are
  configured (registers, retention, lock-and-key storage), but **NDPS is not**.
  The Narcotic Drugs and Psychotropic Substances Act, 1985 and the "essential
  narcotic drugs" regime run through STATE licensing of recognised institutions,
  which is a sub-national specialist question. A half-read version is worse than
  none, so the cell stays `RR` until somebody qualified does it.
- **Quantity / refill limits — `RR`.** Refills ARE configured — rule 65(11)(a)
  means a scheduled prescription is not repeated unless the prescriber endorsed
  it. **No quantity limit exists** in the Drugs Rules for Schedule H, H1 or X;
  where India limits quantity it is NDPS's doing, per the point above. The row
  combines two dimensions and the weaker one governs it.
- **Age restrictions — `RR`.** The Drugs Rules impose none. Inventing a
  plausible age would be inventing law.
- **Online pharmacy permitted — `UNK`,** the one cell in this whole file at
  `UNKNOWN`, and it is the correct value. The draft e-pharmacy rules
  (G.S.R. 817(E), 28 August 2018) were **never notified** and remain draft years
  later, so no published rule says remote supply either is or is not permitted.
  No `ONLINE_DISPENSING` rule is written; what IS written is that the
  prescription, substitution and labelling rules apply to `ONLINE_DISPENSE` as
  much as to a counter sale, because rule 65(9)(a) speaks about a "sale by
  retail" and says nothing about the channel.

  ⚠️ **PI-12 MADE THAT CELL OPERATIVE, AND THE CONSEQUENCE IS DELIBERATE.**
  Because the pack applies its counter rules to `ONLINE_DISPENSE`, a remote supply
  in India would have been decided entirely by rules about a counter — permitted
  where a prescription was presented, and nothing anywhere asking whether the
  product may be sent out at all. The engine now refuses a remote supply until
  somebody records a position on `product_regulatory_profiles
.online_sale_position` **per product, per jurisdiction**. The cost is that
  every online order in India is refused out of the box, which is the honest
  reading of "the rules were never notified": a clinic that has taken a view
  records it against its own products and owns that view.

- **Storage / cold chain — `RR`.** Only Schedule X's lock-and-key requirement
  (rule 65(12)) is sourced. General cold-chain obligations were not researched.
- **Sub-national variation — `RR`.** India's state drugs controllers license and
  inspect; whether any varies these particular obligations is unresearched. The
  framework is ready — a pack on `(IN, KA)` supersedes the national one per rule
  type — and PI-6 wrote none.
- **Product registration, identifier scheme, pharmacy licensing, traceability,
  batch recording, expiry, recall, reporting, external integration — `RR`.** Out
  of PI-6's scope. Several are PI-10's (recall and traceability) and PI-23's
  (identifiers).

---

## Platform capability, by contrast

These are `SUPPORTED` for every country today, because they are architectural
rather than jurisdictional:

| Capability                                    | Status                                                          |
| --------------------------------------------- | --------------------------------------------------------------- |
| Country + sub-national jurisdiction modelling | SUPPORTED (`country_code` + `region_code`, already used by tax) |
| Multi-currency                                | SUPPORTED (`Money`, per-branch currency)                        |
| Timezone per branch, format per branch        | SUPPORTED (invariant 6)                                         |
| GST / VAT / Sales-tax schemes                 | SUPPORTED (`@rcln/tax`)                                         |
| External tax provider seam                    | SUPPORTED (`TaxProviderQuote`)                                  |
| Effective-dated tax rules, tenant override    | SUPPORTED                                                       |
| Per-jurisdiction product tax classification   | PLANNED — PI-1.7                                                |
| Per-jurisdiction product regulatory profile   | PLANNED — PI-5.4                                                |
| Versioned, effective-dated rule packs         | PLANNED — PI-5.2                                                |
| Rule-pack maturity states                     | PLANNED — PI-5.6                                                |
| Localisation of product names                 | PLANNED — not yet phased; see OPEN_DECISIONS OD-3               |

---

## How to update this file

1. Find an **authoritative** source — the regulator's own publication.
2. Record it in `regulatory_sources` with URL, published date, effective date
   and retrieval date.
3. Only then change the cell, and cite the source id in the notes.
4. Set `Last reviewed`.
5. Update the maturity state in [REGULATORY_RULE_PACKS.md](REGULATORY_RULE_PACKS.md).

If you cannot find a source, leave the cell as it is. That is the correct
outcome, not a failure of the session.
