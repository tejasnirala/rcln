/**
 * The time zones and currencies the clinic settings screen offers.
 *
 * SHORT LISTS ON PURPOSE
 *   There are ~600 IANA zones and ~300 currencies, and a select with 600 rows
 *   is worse than a text box — you cannot find Asia/Kolkata by scrolling. This
 *   is India-first software, so the list is India plus the places an Indian
 *   practice or its owners plausibly operate from, and the label spells out
 *   what the identifier means.
 *
 * THE LIST IS NOT THE VALIDATION
 *   `@rcln/contracts` checks a time zone against `Intl` and a currency against
 *   `Intl.supportedValuesOf('currency')`, so anything real is accepted over the
 *   API whether or not it is here. These are the convenient choices, not the
 *   permitted ones — which is why `withCurrent` exists: a clinic already set to
 *   something off this list must keep seeing its own value, or opening the
 *   screen and pressing Save would quietly move it.
 */

export interface LocaleOption {
  value: string;
  label: string;
}

export const TIMEZONES: LocaleOption[] = [
  { value: 'Asia/Kolkata', label: 'India — Asia/Kolkata' },
  { value: 'Asia/Kathmandu', label: 'Nepal — Asia/Kathmandu' },
  { value: 'Asia/Colombo', label: 'Sri Lanka — Asia/Colombo' },
  { value: 'Asia/Dhaka', label: 'Bangladesh — Asia/Dhaka' },
  { value: 'Asia/Karachi', label: 'Pakistan — Asia/Karachi' },
  { value: 'Asia/Dubai', label: 'United Arab Emirates — Asia/Dubai' },
  { value: 'Asia/Singapore', label: 'Singapore — Asia/Singapore' },
  { value: 'Europe/London', label: 'United Kingdom — Europe/London' },
  { value: 'America/New_York', label: 'US Eastern — America/New_York' },
  { value: 'UTC', label: 'UTC' },
];

export const CURRENCIES: LocaleOption[] = [
  { value: 'INR', label: 'INR — Indian rupee' },
  { value: 'AED', label: 'AED — UAE dirham' },
  { value: 'BDT', label: 'BDT — Bangladeshi taka' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — Pound sterling' },
  { value: 'LKR', label: 'LKR — Sri Lankan rupee' },
  { value: 'NPR', label: 'NPR — Nepalese rupee' },
  { value: 'SGD', label: 'SGD — Singapore dollar' },
  { value: 'USD', label: 'USD — US dollar' },
];

/**
 * The list, guaranteed to contain what the clinic is actually set to.
 *
 * A `<select>` cannot show a value it has no option for — it falls back to the
 * first one, so a clinic on `Asia/Tokyo` would open this screen showing
 * Asia/Kolkata and be moved there by any save it made for another reason.
 */
export function withCurrent(options: LocaleOption[], current: string): LocaleOption[] {
  if (options.some((option) => option.value === current)) return options;
  return [{ value: current, label: current }, ...options];
}
