# BusinessRules/

One index file per module, listing the rules that module owns.

**The rule text lives in [`../07_Business_Rules.md`](../07_Business_Rules.md).**
These files are indexes with stable anchors, so the generated
[module catalog](../06_Module_Catalog.md) can deep-link into a specific rule
without the statement being written twice.

## Adding a rule

1. Write it in `07_Business_Rules.md` under the right group, with the next id in
   sequence and a `**Source.**` line citing `file:line`.
2. Add the id to that module's `businessRules` array in
   [`../modules.json`](../modules.json).
3. Add the row to the module's file here.
4. `pnpm kb` — the module catalog picks up the link.

Ids are permanent. A withdrawn rule is marked withdrawn; the number is never
reused.

## Rule quality bar

A business rule earns an entry when **all** of these hold:

- It constrains behaviour in a way a reasonable engineer might otherwise
  violate.
- It has a reason that is not obvious from the code.
- Breaking it has a consequence worth naming.

Implementation detail, style preferences and restatements of the type system do
not qualify. If the rule is really an architectural choice, write an
[ADR](../Architecture/decisions/README.md) instead and link to it.
