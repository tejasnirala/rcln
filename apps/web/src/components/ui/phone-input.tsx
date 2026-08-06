'use client';

import { COUNTRIES, dialFormatFor } from '@rcln/contracts';
import { cn } from '@/lib/cn';

/**
 * A phone number as ONE control, split into a calling code and a national
 * number.
 *
 * WHY NOT TWO FIELDS
 *   A phone number is one fact. Two adjacent inputs read as two questions, and
 *   the customer has to work out which half wants the `+`, whether the trunk
 *   zero goes in the left box or the right one, and what happens if they paste
 *   a full international number into either. One bordered box with a divider
 *   answers all three by construction: the code is on the left and is not a
 *   text field, the digits are on the right, and the paste is normalised.
 *
 * WHAT IT SUBMITS
 *   A hidden input carrying E.164 — `+912025678900` — because that is the only
 *   shape `phone` in @rcln/contracts accepts and the only one every SMS and
 *   WhatsApp provider takes. The visible parts are unnamed, so nothing else can
 *   reach the form data. This also sidesteps the React 19 form-reset trap
 *   documented on the signup form: a reset cannot corrupt a value that lives in
 *   a hidden input React writes the `value` attribute of.
 *
 * TWO VARIANTS
 *   Pass `onCountryChange` and the code becomes a select (the owner's own
 *   mobile, which need not be in the clinic's country). Omit it and the code is
 *   fixed, derived from the country already chosen — that is the clinic's
 *   reception number, where a second country picker would be a way to get it
 *   wrong.
 */
export function PhoneInput({
  id,
  name,
  countryCode,
  national,
  onNationalChange,
  onCountryChange,
  invalid,
  describedBy: describedByIds,
  autoComplete,
}: {
  /** Matches the <label for> of the surrounding Field. Lands on the number. */
  id: string;
  /** The name the E.164 value is submitted under. */
  name: string;
  countryCode: string;
  /** National significant digits only, no calling code and no trunk zero. */
  national: string;
  onNationalChange: (digits: string) => void;
  /** Provide to make the calling code selectable; omit to fix it. */
  onCountryChange?: (code: string) => void;
  invalid?: boolean;
  describedBy?: string | undefined;
  autoComplete?: string;
}) {
  const dial = dialFormatFor(countryCode);

  /**
   * Everything that is not a digit goes, then the leading zeros.
   *
   * People write their own numbers with a trunk zero in the UK, Ireland and
   * Australia — `07700 900123` — and `+4407700900123` is not a number anyone
   * can call. Stripping on the way in means the field never holds a value that
   * would fail validation for a reason the customer cannot see.
   */
  function clean(raw: string): string {
    return raw.replace(/\D/g, '').replace(/^0+/, '').slice(0, dial.maxDigits);
  }

  return (
    <>
      <div
        className={cn(
          'flex items-stretch overflow-hidden rounded-md border transition-colors',
          'focus-within:border-drape',
          invalid ? 'border-signal' : 'border-rule'
        )}
      >
        {onCountryChange ? (
          /*
           * ⚠️ THE SELECT IS TRANSPARENT AND SITS ON TOP; WHAT YOU READ IS THE
           *   SPAN BENEATH IT. A native <select> closed shows exactly the
           *   selected <option>'s text, so it cannot show "+91" while the open
           *   list shows "+91 IN" — and the list needs the country, because
           *   nobody reads "+971" and thinks "United Arab Emirates".
           *
           *   `opacity-0` and not `hidden`, `sr-only` or a custom listbox: the
           *   control stays a real <select>, so it keeps the platform's own
           *   dropdown, type-ahead, touch behaviour and screen-reader support,
           *   and the popup is drawn by the browser at full opacity rather than
           *   inheriting this element's. Nothing here reimplements a menu.
           */
          /*
             The focus ring has to be redrawn here: the real one lands on a
             transparent element, and the global `:focus-visible` rule puts it
             3px OUTSIDE the box — where the parent's `overflow-hidden` clips
             it. Inset by 2px it sits on the dial-code panel itself and stays
             visible, which is the whole requirement.
          */
          <span className="border-rule bg-paper relative flex shrink-0 items-center border-r has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-offset-[-2px] has-[select:focus-visible]:outline-[var(--focus-ring)]">
            <span
              aria-hidden="true"
              className="text-ink pointer-events-none flex items-center gap-1.5 py-2.5 pr-2 pl-3 font-mono text-[0.9375rem]"
            >
              {dial.code}
              {/* Says "this opens", which the transparent select cannot. */}
              <svg viewBox="0 0 10 6" className="h-[0.375rem] w-2.5 fill-current">
                <path d="M0 0h10L5 6z" />
              </svg>
            </span>
            <select
              /*
               * Its own accessible name: the surrounding <label> points at the
               * number input, so without this the select is announced as
               * unlabelled — and "+91" alone does not say what it is.
               */
              aria-label="Country calling code"
              value={countryCode}
              onChange={(event) => onCountryChange(event.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            >
              {COUNTRIES.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.dial.code} {option.name}
                </option>
              ))}
            </select>
          </span>
        ) : (
          <span
            className="border-rule bg-paper text-ink flex shrink-0 items-center border-r px-3 font-mono text-[0.9375rem]"
            // Read as part of the number by a screen reader, via the hint the
            // Field points at — announcing "+91" on its own between the label
            // and the box is noise.
            aria-hidden="true"
          >
            {dial.code}
          </span>
        )}

        <input
          id={id}
          type="tel"
          inputMode="tel"
          value={national}
          onChange={(event) => onNationalChange(clean(event.target.value))}
          /*
           * A pasted `+91 20 2567 8900` would otherwise become `912025678900`
           * and then be sent as `+91912025678900`. Detecting our own calling
           * code at the head of a paste and dropping it is the one case where
           * guessing is safer than not.
           */
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text').trim();
            if (!pasted.startsWith('+') && !pasted.startsWith('00')) return;
            event.preventDefault();
            const digits = pasted.replace(/\D/g, '').replace(/^00/, '');
            const withoutCode = digits.startsWith(dial.code.slice(1))
              ? digits.slice(dial.code.length - 1)
              : digits;
            onNationalChange(clean(withoutCode));
          }}
          {...(autoComplete ? { autoComplete } : {})}
          className="text-ink placeholder:text-muted bg-card min-w-0 flex-1 px-3.5 py-2.5 font-mono text-[0.9375rem] focus:outline-none"
          placeholder={dial.example}
          aria-invalid={Boolean(invalid)}
          {...(describedByIds ? { 'aria-describedby': describedByIds } : {})}
        />
      </div>

      {/* The authoritative value. See the note at the top of the file. */}
      <input type="hidden" name={name} value={national ? `${dial.code}${national}` : ''} />
    </>
  );
}
