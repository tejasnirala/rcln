# Country Support Matrix

A living document. **A regulatory cell stays `RESEARCH_REQUIRED` until a real
source is found, read and recorded** in `regulatory_sources`. India is the first
country where some of them have moved; every other country's are untouched.

**Last updated:** 2026-08-13 · **India at `AUTOMATED_TESTED`; every other row at
`ARCHITECTURE_SUPPORTED`**

⚠️ **INDIA IS THE ONLY CONFIGURED JURISDICTION.** PI-6 seeded pack `IN 1.0.0` —
3 sources, 22 rules — from CDSCO's own consolidated Drugs Rules, 1945 and the
Pharmacy Act, 1948 on India Code. **Every other country still has no
`regulatory_rule_packs` row at all**, so every evaluation outside India answers
`UNDETERMINED`, which refuses.

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

| Country              | ISO | Rule pack phase | Maturity                 | Tax scheme (existing engine) | Sub-national tax                                          | Notes                                                                                                                                                       |
| -------------------- | --- | --------------- | ------------------------ | ---------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| India                | IN  | PI-6            | `AUTOMATED_TESTED`       | GST                          | ✅ state — `INTRA_STATE_HALVES` split already implemented | **Configured.** Pack `IN 1.0.0`, 22 rules, 3 sources. No sub-national pack; no NDPS. See the dimension table below for what is still open.                  |
| United States        | US  | PI-13           | `ARCHITECTURE_SUPPORTED` | SALES_TAX                    | ✅ state/county/city/district                             | Tax requires the `TaxProviderQuote` seam — a rate table cannot be honest here. Regulation is federal **plus** state, and the pack must be state-extensible. |
| United Kingdom       | GB  | PI-14           | `ARCHITECTURE_SUPPORTED` | VAT                          | ✖                                                         |                                                                                                                                                             |
| Australia            | AU  | PI-15           | `ARCHITECTURE_SUPPORTED` | GST                          | State/territory variation likely on the regulatory side   |                                                                                                                                                             |
| Singapore            | SG  | PI-16           | `ARCHITECTURE_SUPPORTED` | GST                          | ✖                                                         |                                                                                                                                                             |
| United Arab Emirates | AE  | PI-17           | `ARCHITECTURE_SUPPORTED` | VAT                          | Emirate-level regulatory variation likely                 |                                                                                                                                                             |
| Ireland              | IE  | PI-18           | `ARCHITECTURE_SUPPORTED` | VAT                          | ✖                                                         |                                                                                                                                                             |
| Nepal                | NP  | PI-19           | `ARCHITECTURE_SUPPORTED` | VAT                          | RESEARCH_REQUIRED                                         |                                                                                                                                                             |
| Sri Lanka            | LK  | PI-20           | `ARCHITECTURE_SUPPORTED` | VAT                          | RESEARCH_REQUIRED                                         |                                                                                                                                                             |
| Bangladesh           | BD  | PI-21           | `ARCHITECTURE_SUPPORTED` | VAT                          | RESEARCH_REQUIRED                                         |                                                                                                                                                             |

The "tax scheme" column reflects which `TaxScheme` member the **existing**
`@rcln/tax` would use. It is a statement about the engine's vocabulary, **not** a
statement about any country's tax law, and it does not mean rates are
configured. Rates come from `tax_rules` / `tax_rule_defaults`, which are empty
for every country except what a clinic configures for itself.

---

## Regulatory dimensions

The table exists so that research has a shape, and so that a partially-researched
country is visibly partial. India is exactly that: some cells sourced, most not.

| Dimension                             | IN         | US  | GB  | AU  | SG  | AE  | IE  | NP  | LK  | BD  |
| ------------------------------------- | ---------- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Regulatory authority                  | SUP        | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Product registration requirement      | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| National product identifier scheme    | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Prescription classification scheme    | SUP        | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Controlled-substance scheduling       | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Dispensing restrictions               | SUP        | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Pharmacy licensing                    | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Pharmacist qualification requirements | SUP        | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Generic substitution rules            | SUP        | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Quantity / refill limits              | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Age restrictions                      | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Online pharmacy permitted             | UNK        | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Traceability / serialisation mandate  | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Batch/lot recording requirements      | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Expiry handling requirements          | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Storage / cold chain requirements     | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Labelling requirements                | SUP        | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Recall procedure and obligations      | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Record retention period               | SUP        | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Reporting obligations                 | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Veterinary-specific rules             | SUP        | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Sub-national variation exists         | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| External system integration required  | RR         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Source references recorded            | ✅         | ✖   | ✖   | ✖   | ✖   | ✖   | ✖   | ✖   | ✖   | ✖   |
| Last reviewed                         | 2026-08-13 | —   | —   | —   | —   | —   | —   | —   | —   | —   |

`RR` = `RESEARCH_REQUIRED` · `SUP` = `SUPPORTED` · `UNK` = `UNKNOWN`.

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
