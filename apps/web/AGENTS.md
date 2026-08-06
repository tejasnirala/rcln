<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Building UI here

**Load the `frontend-design` skill before writing a new screen, component, or any
CSS.** Before the first line of JSX — it decides palette, type, layout and the
signature element, and retrofitting a direction onto finished markup means
rewriting the markup. This applies to new UI and to reshaping existing UI. It does
not apply to a logic-only change inside a component that already has its design.

Two calibrations for this product, which the skill cannot know:

- **rcln is a clinical tool, not a landing page.** The skill's "take one real
  aesthetic risk" belongs in the marketing surface and the tenant-facing shell.
  Inside the app — appointment queues, prescription entry, dispensing, billing —
  the job is legibility and speed for someone working through a waiting room.
  Spend boldness on the shell and the empty/onboarding states; keep dense
  data-entry screens quiet and conventional.
- **The design direction is decided once, then reused.** The first screen sets
  palette, type scale and spacing; every screen after it inherits them. A second
  screen with its own distinct direction is a bug, not a fresh design. Read what
  the existing screens already do before proposing anything new.

## Form controls come from `components/ui/field.tsx`

`Input`, `Select` and `Textarea` are the whole form vocabulary. Each is `Field`
plus a native control with the label, hint, error, `aria-describedby` and
`aria-invalid` already wired, controlled (`value` + `onChange`) or uncontrolled
(`defaultValue`) exactly as React means it. Every other prop lands on the native
element, so `type`, `inputMode`, `autoComplete`, `rows` and the rest behave
normally.

**Do not hand-assemble a `<Field>` around a bare `<input className={inputClass}>`.**
That is what these replaced, and it is how the app ended up with labels pointing
at ids that did not exist and `aria-describedby` pointing at hints that had been
swapped out for an error. `inputClass` and `selectClass` stay exported only for
the controls the components cannot be — `PhoneInput` and `clinic-finder`, where
the control sits inside a shared bordered group, and checkboxes, where the label
wraps the box.

`type="password"` on `Input` renders the field with a reveal toggle, decided by
the component and not by the call site — there is no `PasswordInput` to reach
for and no `showToggle` prop to forget. A new password box anywhere gets it.

`Select` renders a real `<select>`. The open list is the operating system's and
we do not style it; that is the price of keeping platform keyboard navigation,
type-ahead, the mobile wheel picker and screen-reader support. Options go in as
data — `options={[{ value, label }]}`, a `{ label, options }` entry for a group,
`placeholder` for a disabled first row.

## Accessibility is part of the design, not a pass afterwards

The marketing surface was audited and fixed; the same rules bind every screen
after it. These are the ones that were actually got wrong the first time:

- **Contrast is measured, not eyeballed.** 4.5:1 for text under 24px, 3:1 above.
  This includes **placeholders** and any `text-*/60`-style opacity modifier —
  `text-muted/60` on white is 2.4:1. The tokens in `globals.css` are already
  tuned; use them solid rather than fading them.
- **Colour is never the only carrier of meaning** (WCAG 1.4.1). A tick, a dash
  or a dimmed row needs a `sr-only` word next to it saying what it means.
- **Interactive things are at least 24×24** (WCAG 2.5.8). Inline links in a nav
  or list are ~19px from line-height alone; `globals.css` adds the padding.
- **Anything that moves on its own needs a visible pause control** (WCAG 2.2.2),
  not just "it stops if you interact with it".
- **Every input gets `aria-describedby`** pointing at its hint and its error. An
  error that is on screen but unlinked does not exist to a screen reader. On a
  failed submit, move focus to the first field at fault.
- **Never put `aria-hidden` around something focusable** — use `inert`, which
  removes it from both the accessibility tree and the tab order.
- **The focus ring must be visible on the surface it lands on.** `--focus-ring`
  is re-pointed by the `on-ink` utility for dark sections.

Verify by measurement before claiming it: contrast ratios, target sizes and
overflow are all checkable in the browser console, and "it looks fine" is how
the first version shipped with five failures.

The skill's guidance on interface copy — active voice, name things by what the
user controls, an action keeps its name through the whole flow, errors say what
happened and how to fix it — applies everywhere, with no exceptions. Never put a
patient name or other PHI into placeholder or example copy; use obviously fake
data.

Performance is a separate axis: also consult `vercel-react-best-practices`.
