/**
 * The form primitives every screen uses. Extracted from the demo form so the
 * accessibility wiring — label association, hint and error ids, the described-by
 * plumbing — is written once and inherited, rather than re-derived (and got
 * subtly wrong) on each new form.
 *
 * Accessibility rules these encode are recorded in apps/web/AGENTS.md.
 *
 * `Input`, `Select` and `Textarea` are what a screen should reach for. They are
 * `Field` plus a native control with the wiring already connected, so a form
 * field is one call and cannot be assembled wrongly. `Field` itself stays
 * exported for the controls these cannot be — `PhoneInput`, a checkbox whose
 * label wraps the box, a radio group.
 */

import { cn } from '@/lib/cn';
import { PasswordControl } from '@/components/ui/password-control';

/**
 * The ids a field's hint and error are published under, so the input can point
 * at them with aria-describedby. Without this the error is on screen and a
 * screen reader never reads it.
 *
 * ⚠️ AN INVALID FIELD IS DESCRIBED BY ITS ERROR AND NOTHING ELSE. `Field`
 *   renders the error IN PLACE OF the hint, so `${name}-hint` is not in the
 *   document while the field is at fault and pointing at it would be a dangling
 *   reference. This also matches what the customer is being told: when
 *   something is wrong, the fix is the message, not the format reminder.
 */
export function describedBy(name: string, hint: boolean, invalid: boolean): string | undefined {
  if (invalid) return `${name}-error`;
  return hint ? `${name}-hint` : undefined;
}

/**
 * The rules every field in this app is laid out by, in one place.
 *
 * ⚠️ THE HINT GOES BELOW THE INPUT, NOT ABOVE IT. It used to sit between the
 *   label and the control, which meant that in any two-column grid a field with
 *   a hint pushed its input a line lower than the field beside it — "Email" and
 *   "Mobile" side by side, inputs on different baselines, on the signup form.
 *   Below the input every label and every control lines up across a row no
 *   matter which fields happen to carry hints, and the hint still reads before
 *   the customer has typed anything.
 *
 * ⚠️ ONE LINE OWNS THE SLOT UNDER THE CONTROL — the error REPLACES the hint,
 *   they are never both on screen. With both rendered, the hint sat exactly
 *   where an error sits, at the same size and the same offset, and a clean
 *   step 4 read as "every field already has a message under it". Colour was
 *   the only thing telling them apart, which is precisely what WCAG 1.4.1
 *   says cannot carry the difference. Errors now also carry a glyph and say
 *   the word "Error", so the distinction survives without it.
 *
 * Order is label → control → hint-or-error, which is also the reading order.
 */
export function Field({ name, label, hint, errors, action, className, children }: FieldProps) {
  const error = errors?.[0];

  return (
    <div className={cn('flex flex-col', className)}>
      {label || action ? (
        <div className="flex items-baseline justify-between gap-3">
          {label ? (
            <label htmlFor={name} className="text-ink block text-sm font-medium">
              {label}
            </label>
          ) : null}
          {action}
        </div>
      ) : null}
      <div className={label || action ? 'mt-2' : undefined}>{children}</div>
      {error ? (
        <FieldError name={name} message={error} />
      ) : hint ? (
        <p id={`${name}-hint`} className="text-muted mt-1.5 text-[0.8125rem] leading-snug">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A field's error message, for the controls that cannot use `Field` — a
 * checkbox whose label wraps the box, for one. Same markup either way, so an
 * error never looks like an error in one place and a hint in another.
 */
export function FieldError({ name, message }: { name: string; message: string }) {
  return (
    <p
      id={`${name}-error`}
      className="text-signal mt-1.5 flex items-start gap-1.5 text-[0.8125rem] leading-snug"
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="mt-[0.1875rem] h-3.5 w-3.5 shrink-0 fill-current"
      >
        <path d="M8 1.5 15 14H1L8 1.5Zm0 4.25a.75.75 0 0 0-.75.75v2.75a.75.75 0 0 0 1.5 0V6.5A.75.75 0 0 0 8 5.75Zm0 5.5a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z" />
      </svg>
      {/* Colour is not the only carrier of meaning (WCAG 1.4.1). */}
      <span className="sr-only">Error: </span>
      <span>{message}</span>
    </p>
  );
}

interface FieldProps {
  name: string;
  /** Omitted only when the control names itself — see `aria-label` on `Input`.
   *  A node rather than a string, so a label can carry an "Optional" tag. */
  label?: React.ReactNode;
  hint?: string;
  errors?: string[];
  /** Optional control rendered opposite the label, e.g. a "Forgot password" link. */
  action?: React.ReactNode;
  /** On the wrapper, e.g. `sm:col-span-2`. Not on the control. */
  className?: string;
  children: React.ReactNode;
}

// Placeholders carry the expected format, so they are held to the same 4.5:1
// as any other text. At 60% opacity this was 2.4:1.
export const inputClass =
  'w-full rounded-md border border-rule bg-card px-3.5 py-2.5 text-[0.9375rem] text-ink placeholder:text-muted transition-colors hover:border-muted focus:border-drape focus:outline-none disabled:cursor-not-allowed disabled:border-rule disabled:bg-paper disabled:text-muted';

/**
 * Every native <select> in the app. Same box as `inputClass` so a row of mixed
 * controls lines up, with four differences that are all about the arrow.
 *
 * ⚠️ USE THIS, NOT `inputClass`, ON A <select>. They used to share one class,
 *   which meant the browser drew its own arrow — a different shape on each
 *   platform, in a colour we do not control, jammed against the right border
 *   with no padding at all, and on Chrome overlapping the last character of a
 *   long option. `appearance-none` removes it; `field-chevron` (globals.css)
 *   paints ours with `pr-10` reserving the room.
 *
 * The right padding is deliberately larger than the left: the arrow lives in
 * it, so matching `pl-3.5` would put text under the glyph.
 *
 * A select is a menu, so it gets `cursor-pointer` — a text caret over something
 * you cannot type into is a small lie about what the control does. Disabled
 * says so by surface and cursor together, never by colour alone (WCAG 1.4.1);
 * the option text stays at `muted`, which is 4.6:1 on paper.
 */
export const selectClass =
  'field-chevron w-full cursor-pointer appearance-none rounded-md border border-rule bg-card py-2.5 pr-10 pl-3.5 text-[0.9375rem] text-ink transition-colors hover:border-muted focus:border-drape focus:outline-none disabled:cursor-not-allowed disabled:border-rule disabled:bg-paper disabled:text-muted';

/** A textarea is an input that grew; only the height and the grabber differ. */
export const textareaClass = `${inputClass} resize-y`;

/* ------------------------------------------------------------------ *
 * The controls
 * ------------------------------------------------------------------ */

/**
 * What a field is keyed by.
 *
 * ⚠️ `id` AND `name` ARE NOT THE SAME THING HERE, AND BOTH ARE NEEDED. `name`
 *   is what the value submits under and repeats across a list — every row of
 *   the member table has a `roleId`. `id` is what the label points at and must
 *   be unique in the document, so those rows need `id={`roleId-${member.id}`}`.
 *   Keying the hint and error off `name` would have every row's error announced
 *   for every row.
 *
 * The union says: give me at least one. `id` falls back to `name` because they
 * are the same for the common case of one form on a page, and requiring both
 * everywhere would be noise that people copy wrongly.
 *
 * `name` is genuinely optional, not just defaulted: the signup form's selects
 * deliberately carry no name and submit through hidden inputs instead, because
 * React 19 resets a form after an action and a <select> loses its value when it
 * does. See the note at the foot of signup-form.tsx.
 */
type ControlIdentity = { id: string; name?: string } | { id?: string; name: string };

interface ControlShell {
  /** Omit only when the control is named some other way — `aria-label`, or a
   *  wrapping <label>. Without one of those it is an unlabelled control. */
  label?: React.ReactNode;
  hint?: string;
  errors?: string[];
  /**
   * ⚠️ THE SINGULAR SPELLING, DECLARED SO IT IS A TYPE ERROR RATHER THAN A
   *   SILENT NO-OP.
   *
   *   Four screens had written `error={message}`, which is the obvious guess
   *   and does nothing: the prop is named `errors` and takes an array, so the
   *   singular one fell through the spread onto the native element, React
   *   dropped it as an unknown attribute, and the field rendered clean while
   *   the customer was told nothing about what was wrong with it.
   *
   *   Excess-property checking did not catch it, and could not: every call site
   *   spread a conditional object (`{...(err ? { error: err } : {})}`), and TS
   *   only applies that check to object literals written inline. Declaring the
   *   property as `never` moves the failure from "unchecked extra key" to
   *   "string is not assignable to never", which no spread hides.
   */
  error?: never;
  /** Rendered opposite the label, e.g. a "Forgot password" link. */
  action?: React.ReactNode;
  /** On the Field wrapper, e.g. `sm:col-span-2`. `className` is on the control. */
  fieldClassName?: string;
}

/**
 * The wiring every control shares, in one place.
 *
 * ⚠️ `aria-invalid` IS SET EVEN WHEN THE FIELD IS FINE — as "false", not
 *   omitted. `useOutcomeFocus` finds the first field at fault with
 *   `querySelector('[aria-invalid="true"]')`, and a control that only grows the
 *   attribute when it breaks is a control that works; but a stale "true" left
 *   on a field the customer has since fixed would steal that focus. Rendering
 *   the current answer both times is what keeps the two in step.
 */
function controlProps(
  fieldId: string,
  hint: string | undefined,
  invalid: boolean
): { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined } {
  return {
    id: fieldId,
    'aria-invalid': invalid,
    'aria-describedby': describedBy(fieldId, Boolean(hint), invalid),
  };
}

/**
 * A field is a shell around a control — unless there is nothing to put in the
 * shell, in which case it is just the control.
 *
 * The bare form is not a special case anyone asks for; it is what a control
 * with no label, hint or error already is. A <select> inside a wrapping
 * <label>, or one carrying its own `aria-label`, would otherwise be handed an
 * empty `flex flex-col` div that breaks the layout it sits in.
 */
function withShell(
  fieldId: string,
  { label, hint, errors, action, fieldClassName }: ControlShell,
  control: React.ReactNode
): React.ReactElement {
  if (!label && !hint && !errors?.length && !action) return <>{control}</>;
  return (
    <Field
      name={fieldId}
      hint={hint}
      errors={errors}
      action={action}
      className={fieldClassName}
      {...(label ? { label } : {})}
    >
      {control}
    </Field>
  );
}

/**
 * A text field, with its label, hint, error and the aria that ties them
 * together.
 *
 * CONTROLLED OR UNCONTROLLED, the same way React already means it: pass `value`
 * with `onChange` for the first, `defaultValue` for the second. Nothing here
 * owns the value or decides between them — every remaining prop lands on the
 * native <input>, so `type`, `autoComplete`, `inputMode`, `maxLength`, `onPaste`
 * and the rest work exactly as they do on a bare element.
 *
 *   <Input name="email" type="email" label="Work email" errors={err('email')} />
 *   <Input name="pin" label="PIN code" value={pin} onChange={…} className="font-mono" />
 */
export function Input({
  label,
  hint,
  errors,
  action,
  fieldClassName,
  className,
  id,
  name,
  ...rest
}: ControlIdentity & ControlShell & Omit<InputElementProps, 'id' | 'name'>) {
  const fieldId = identify(id, name);
  const shared = {
    ...controlProps(fieldId, hint, Boolean(errors?.length)),
    ...(name === undefined ? {} : { name }),
  };

  /*
   * ⚠️ EVERY PASSWORD FIELD GETS THE REVEAL TOGGLE, AND IT IS DECIDED HERE
   *   RATHER THAN AT THE CALL SITE. There is no `<PasswordInput>` to remember
   *   to reach for and no `showToggle` prop to forget: `type="password"` IS the
   *   request for a masked field, and a masked field the customer cannot read
   *   back is the thing being fixed. Adding a sixth password box anywhere in
   *   the app gets this for free.
   *
   *   `pr-11` reserves the button's width so it never sits over the text — the
   *   same arrangement as the chevron on `Select`. A caller's own `pr-*` still
   *   wins through `cn`, which would put the button on top of the value; there
   *   is no reason to do that.
   */
  if (rest.type === 'password') {
    return withShell(
      fieldId,
      { label, hint, errors, action, fieldClassName },
      <PasswordControl {...shared} className={cn(inputClass, 'pr-11', className)} {...rest} />
    );
  }

  return withShell(
    fieldId,
    { label, hint, errors, action, fieldClassName },
    <input {...shared} className={cn(inputClass, className)} {...rest} />
  );
}

/**
 * A native <select>, styled as one control and used everywhere.
 *
 * ⚠️ THE OPEN LIST IS DRAWN BY THE OPERATING SYSTEM AND WE DO NOT STYLE IT.
 *   That is the trade this component makes on purpose. In exchange the control
 *   keeps the platform's keyboard navigation, type-ahead, the iOS and Android
 *   wheel pickers and screen-reader support — none of which a div-and-popup
 *   listbox gets without re-earning it, and all of which someone working
 *   through a waiting room notices the absence of. Only the closed control is
 *   ours; `selectClass` covers it.
 *
 * Options come as data, or as `children` when they cannot: a leading disabled
 * placeholder is `placeholder`, and grouped options are a `{ label, options }`
 * entry, but anything stranger is still just JSX.
 */
export function Select({
  label,
  hint,
  errors,
  action,
  fieldClassName,
  className,
  id,
  name,
  options,
  placeholder,
  children,
  ...rest
}: ControlIdentity &
  ControlShell &
  Omit<SelectElementProps, 'id' | 'name'> & {
    options?: SelectItem[];
    /** A disabled first option, for "choose one" with no sensible default. */
    placeholder?: string;
  }) {
  const fieldId = identify(id, name);
  return withShell(
    fieldId,
    { label, hint, errors, action, fieldClassName },
    <select
      {...controlProps(fieldId, hint, Boolean(errors?.length))}
      {...(name === undefined ? {} : { name })}
      className={cn(selectClass, className)}
      {...rest}
    >
      {placeholder ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options?.map((item) =>
        'options' in item ? (
          <optgroup key={item.label} label={item.label}>
            {item.options.map(renderOption)}
          </optgroup>
        ) : (
          renderOption(item)
        )
      )}
      {children}
    </select>
  );
}

/** Free text over several lines. `rows` sets the starting height. */
export function Textarea({
  label,
  hint,
  errors,
  action,
  fieldClassName,
  className,
  id,
  name,
  ...rest
}: ControlIdentity & ControlShell & Omit<TextareaElementProps, 'id' | 'name'>) {
  const fieldId = identify(id, name);
  return withShell(
    fieldId,
    { label, hint, errors, action, fieldClassName },
    <textarea
      {...controlProps(fieldId, hint, Boolean(errors?.length))}
      {...(name === undefined ? {} : { name })}
      className={cn(textareaClass, className)}
      {...rest}
    />
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectOptionGroup {
  label: string;
  options: SelectOption[];
}

export type SelectItem = SelectOption | SelectOptionGroup;

function renderOption(option: SelectOption): React.ReactElement {
  return (
    <option key={option.value} value={option.value} disabled={option.disabled ?? false}>
      {option.label}
    </option>
  );
}

/**
 * The one place the id/name fallback lives.
 *
 * The `?? ''` is unreachable — `ControlIdentity` is a union that requires one
 * of the two — but TypeScript cannot narrow a union through destructured
 * props, and an empty id is a better failure than a `!` that lies about it.
 */
function identify(id: string | undefined, name: string | undefined): string {
  return id ?? name ?? '';
}

type InputElementProps = React.ComponentPropsWithoutRef<'input'>;
type SelectElementProps = React.ComponentPropsWithoutRef<'select'>;
type TextareaElementProps = React.ComponentPropsWithoutRef<'textarea'>;
