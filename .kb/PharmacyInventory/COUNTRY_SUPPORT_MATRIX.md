# Country Support Matrix

A living document. **Every regulatory cell is `RESEARCH_REQUIRED` and must stay
that way until a real source is found, read and recorded** in
`regulatory_sources`.

**Last updated:** 2026-08-11 · **All rows at maturity:** `ARCHITECTURE_SUPPORTED`

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
| India                | IN  | PI-6            | `ARCHITECTURE_SUPPORTED` | GST                          | ✅ state — `INTRA_STATE_HALVES` split already implemented | Pilot pack. The tax side is the most exercised in the codebase.                                                                                             |
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

Every cell below is `RESEARCH_REQUIRED` for every country. The table exists so
that research has a shape, and so that a partially-researched country is
visibly partial.

| Dimension                             | IN  | US  | GB  | AU  | SG  | AE  | IE  | NP  | LK  | BD  |
| ------------------------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Regulatory authority                  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Product registration requirement      | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| National product identifier scheme    | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Prescription classification scheme    | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Controlled-substance scheduling       | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Dispensing restrictions               | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Pharmacy licensing                    | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Pharmacist qualification requirements | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Generic substitution rules            | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Quantity / refill limits              | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Age restrictions                      | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Online pharmacy permitted             | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Traceability / serialisation mandate  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Batch/lot recording requirements      | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Expiry handling requirements          | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Storage / cold chain requirements     | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Labelling requirements                | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Recall procedure and obligations      | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Record retention period               | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Reporting obligations                 | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Veterinary-specific rules             | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Sub-national variation exists         | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| External system integration required  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  | RR  |
| Source references recorded            | ✖   | ✖   | ✖   | ✖   | ✖   | ✖   | ✖   | ✖   | ✖   | ✖   |
| Last reviewed                         | —   | —   | —   | —   | —   | —   | —   | —   | —   | —   |

`RR` = `RESEARCH_REQUIRED`.

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
