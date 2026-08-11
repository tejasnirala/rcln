# Consumable Architecture

Short, because the whole point is that there is almost nothing here.

---

## Consumables are products

Gloves, syringes, needles, gauze, cotton, bandages, disinfectants, dental
materials, surgical supplies, lab consumables, veterinary supplies — every one
of them is a row in `products` with a `ProductType` other than `MEDICINE`.

They use the same catalogue, the same units and packaging engine, the same
locations, the same batches, the same ledger, the same allocation and the same
reports. **There is no consumables subsystem.**

---

## Why not a separate module

The tempting design is `medicines` for pharmacy and `consumables` for
everything else. It fails in four ways, all of them expensive:

1. **Two ledgers.** One of them is always the neglected one, and it is always
   the one the auditor asks about.
2. **The overlap is large and growing.** A syringe is a consumable; a
   pre-filled syringe of anaesthetic is a medicine in a syringe. A vaccine is
   both. A dental anaesthetic cartridge is both. Every boundary case needs a
   rule, and the rules disagree between countries.
3. **Reports fragment.** "What did this procedure cost in materials" spans both,
   and a union query across two shapes is a report nobody trusts.
4. **Recall and traceability break.** A recalled batch of gloves is exactly as
   urgent as a recalled batch of medicine, and it needs exactly the same
   machinery.

PI-ADR-001.

---

## What actually differs

Only three things, and all three are already per-product data:

| Difference                                           | Where it lives                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| A consumable has no composition                      | `products.composition_id` is NULL                                     |
| A consumable usually has no prescription requirement | The regulatory profile says so — per jurisdiction, not per type       |
| A consumable is usually not separately billed        | The charge policy says so — per product/procedure/payer, not per type |

Note the second and third are _usually_, not _always_. A surgical implant is a
consumable that is separately billable and often serialised and regulated. A
diagnostic kit may be restricted. Encoding "consumables are free and
unregulated" as a type-level assumption is wrong within the first month of real
use.

⚠️ **Never branch behaviour on `ProductType`.** It is metadata for the UI and
for reporting rollups, the same warning the clinical taxonomy's
`TaxonomyNodeType` already carries. Behaviour comes from the regulatory profile
and the charge policy.

---

## Tracking

Consumables commonly use `tracking_mode = LOT_BATCH` with
`is_expiry_controlled = true` (sterile items expire), sometimes `NONE` (bulk
cotton), and occasionally `SERIAL` (an implant). All three are configured per
product, not implied by type. PI-ADR-014.

---

## Where they are consumed

- **A procedure** → PI-9, via a consumption template
- **A dispense** → PI-7, when handed to a patient (a glucometer strip pack)
- **An adjustment** → PI-3, for wastage outside any clinical event

All three are ordinary ledger movements with different `movement_type` values
and different references. See [CLINICAL_CONSUMPTION.md](CLINICAL_CONSUMPTION.md).
