# Modular Revamp

Turns rcln from "a clinic app with extras" into **one platform of independent,
separately-purchasable modules** — Clinic, Pharmacy, Lab, HR, and whatever comes
next — sharing one core (patients, invoicing, inventory, reports, admin). The
navigation is the visible half; the module registry, entitlement checks and
module-aware roles are the half that makes it real.

```text
BRANCH:          feat/module-revamp   (everything lands here; merged to main when the revamp is done)
CURRENT PHASE:   P1 — Paper design
LAST COMPLETED:  P0 — Requirements agreed (2026-10-06)
NEXT:            Design the P1 frames in Paper, get sign-off, then P2
BLOCKERS:        none
```

## Files

| File                     | What it is                                                                  |
| ------------------------ | --------------------------------------------------------------------------- |
| [SPEC.md](SPEC.md)       | **The source of truth.** Every decision (D1–D24), the navigation, the rules |
| [TRACKER.md](TRACKER.md) | Phases, checklists, session log — what is done, what is next                |

## Starting a new session on this work

1. `git checkout feat/module-revamp`
2. Read the status block above, then `TRACKER.md` → the first unchecked item.
3. Read the `SPEC.md` sections that item cites. Do not re-open a decision in
   SPEC.md § Decisions — they are settled. If something genuinely conflicts,
   raise it and record the change there, with the date.
4. When you finish, tick the item, add a line to the session log, and update the
   status block above.

## Ground rules

- **Design first.** No production code until the P1 frames are signed off.
  Paper frames are the reference for P2 onwards.
- The project's invariants and `CLAUDE.md` still apply in full. Where this
  revamp changes an existing behaviour (Clinic becoming purchasable, the API
  refusing unbought modules, invoice visibility), SPEC.md says so explicitly.
- Hand-written; not touched by `pnpm kb`.
