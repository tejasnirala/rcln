# Tax Integration

**This programme writes no tax logic.** Its entire tax responsibility is one
function:

```ts
resolveTaxCategory(productId, jurisdiction, on: Date): string | null
```

Everything downstream already exists and is tested.

---

## Why nothing needs building

`@rcln/tax` was audited on 2026-08-11 and is already global. It is not
India-specific and does not need generalising:

| Requirement from the brief           | Already true                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Jurisdiction-aware                   | `Jurisdiction { countryCode, regionCode }`, ISO 3166-2 without the country prefix                                               |
| Multiple tax regimes                 | `TaxScheme = 'GST' \| 'VAT' \| 'SALES_TAX'`                                                                                     |
| Country-specific line presentation   | `TaxSplit`, `lineName`, `regionalLineName` — Karnataka prints two lines, Singapore one, British Columbia two at different rates |
| Effective-dated rules                | `tax_rules.effective_from` / `.effective_to`                                                                                    |
| Platform defaults + tenant overrides | `tax_rule_defaults` vs `tax_rules`; **TENANT beats PLATFORM before specificity**                                                |
| US sales tax / EU OSS                | `TaxProviderQuote` — a documented seam for external providers, returning `PROVIDER_REQUIRED` when one is needed and absent      |
| Refuses to guess                     | `UNRATED`; `UNISSUABLE_TREATMENTS` blocks issuing                                                                               |
| Reverse charge, zero-rated, exempt   | `TaxTreatment`                                                                                                                  |
| HSN is not the universal identifier  | ✅ **already**: `invoice_items.item_code` is presentation, `invoice_items.tax_category` is the key. Two columns, deliberately.  |

The engine is pure and synchronous — it holds no Prisma client and reads no
database. The caller loads rows and maps them across.

---

## The seam

```text
product
   │
   ├── product_tax_classifications  (country, region?, tax_category,
   │                                  item_code?, effective_from/to)
   │
   ▼
resolveTaxCategory(product, jurisdiction, date) → "3004" | "MED-STD" | null
   │
   ▼
invoice_items.tax_category  ←── the EXACT-MATCH key into tax_rules
invoice_items.item_code     ←── the printed HSN/SAC. Presentation only.
   │
   ▼
@rcln/tax.resolveTax(supply)   ← already handles everything else
```

### What the tax engine is given

The existing invoicing path already assembles this. Pharmacy contributes only
the category:

| Input                | Source                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| net amount           | the charge request's price                                                                         |
| `taxCategory`        | **this programme**                                                                                 |
| issuer registrations | `issuer_tax_registrations` for the org                                                             |
| place of supply      | the **issuing branch's** jurisdiction — a dispensed medicine is physically supplied at the counter |
| customer             | patient's jurisdiction and tax id, if any                                                          |
| rules                | `tax_rules` + `tax_rule_defaults` for the org                                                      |
| supplied at          | the dispense/consumption instant                                                                   |

⚠️ `placeOfSupply` is the branch, not the patient. The engine's own comment
warns about this: getting it backwards bills a Karnataka clinic's supply as
inter-state because the patient happens to live in Kerala.

---

## `tax_category` is not HSN

It happens that an Indian clinic will often use an HSN code as its category
string, because that is convenient. That is a **choice of value**, not a
coupling.

- There is **no prefix tree**. `30049099` does not resolve to `3004`. The engine
  documents why: a prefix match "would apply a confident, unreviewed rate."
- A category with no rule comes back `UNRATED`, and finalisation refuses to
  issue the invoice. That is the designed behaviour, not a bug to route around.
- Other countries use their own systems in the same column — a UK VAT category,
  a Singapore GST classification, a US product tax code. The column is
  `varchar(64)` and jurisdiction-agnostic.

---

## Per-jurisdiction classification

One product, many classifications:

```
Amoxicillin 500 mg capsule
  IN      → tax_category "3004",     item_code "30049099"
  GB      → tax_category "VAT-ZERO", item_code null
  SG      → tax_category "GST-STD",  item_code null
  US-CA   → tax_category "RX-DRUG",  item_code null   (provider quote required)
  AE      → tax_category "VAT-ZERO", item_code null
```

Effective-dated, because classifications change by statute.

`resolveTaxCategory` returns `null` when no classification exists. **`null` is a
visible configuration gap, never a default.** It propagates to `UNRATED` and the
invoice refuses to issue, which is the correct failure — a guessed rate collects
money nobody owed or leaves the clinic owing tax it never took.

---

## Permission

Editing a product's tax classification is gated by `billing.tax.manage`, not a
product code. The existing catalogue explains why at length: a tax rule decides
what every patient is charged and what the clinic owes the government, and that
is the accountant's job, not whoever can edit the catalogue.

---

## Rules

- No `CGST`, `SGST`, `IGST`, `VAT`, `GST` or `Sales Tax` string appears anywhere
  in this programme's code.
- No rate, no percentage, no split logic, no tax label.
- No `if (country === …)` for tax or anything else.
- Purchase-side tax (what a supplier charged) is **recorded**, never computed,
  and does not touch `@rcln/tax`, which prices sales. Input-tax credit is out of
  scope.
