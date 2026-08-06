/**
 * Where a clinic can be, and everything that follows from it.
 *
 * ⚠️ ONE TABLE, READ BY EVERY SCREEN THAT ASKS "WHERE?".
 *   Signup, clinic settings and the platform's tax-registration console all
 *   derive from this. Before it existed each had its own idea: signup hardcoded
 *   `Asia/Kolkata`/`INR`, settings offered a different time-zone list, and the
 *   tax console took a free-text country. Three sources of truth for one fact is
 *   how a clinic ends up registered in `IN` and taxed as `In`.
 *
 * IT LIVES IN CONTRACTS BECAUSE BOTH SIDES NEED IT
 *   The server validates a region against its country and derives the billing
 *   currency; the client renders the same choices. A copy in `apps/web` would
 *   drift, and the drift would show up as a region the API rejects after the
 *   form offered it.
 *
 * WHAT EACH FIELD IS FOR
 *   `currency`   — the billing currency, subject to the plan actually having a
 *                  price in it. `currencyForCountry` in @rcln/payments applies
 *                  that check; this is the preference, not the decision.
 *   `timezones`  — every zone the country uses, most populous first. An ARRAY
 *                  because time zone is not 1:1 with country: India has one and
 *                  asking is noise, the United States has seven and guessing is
 *                  wrong.
 *   `regions`    — ONLY where a sub-national tax registration is a real thing.
 *                  India issues a GSTIN per state and the US registers per
 *                  state; Ireland has counties and they are irrelevant to VAT,
 *                  so it has none. An empty list means "country-wide only", and
 *                  the forms read it that way rather than asking for a region
 *                  nobody can act on.
 *   `tax`        — what a registration in this country would ordinarily be. It
 *                  PREFILLS the console; it never overrides what an operator
 *                  types, and it is not what gets charged. `tax_registrations`
 *                  is the authority — see `resolveTax`.
 *   `dial`       — the E.164 calling code and how many national digits follow
 *                  it, so a phone field can show the code and validate the rest.
 *   `labels`     — what this country calls the parts of an address. NOT
 *                  cosmetic: "State / PIN code" on an Irish clinic is asking a
 *                  question Ireland does not have an answer to.
 *   `postal`     — the postcode format, or null where the country has none.
 *   `taxId`      — the tax registration number a clinic here would hold, and
 *                  what it is called. `null` where there is no single national
 *                  one to ask for (the United States).
 */

export interface Region {
  /** ISO 3166-2 subdivision, without the country prefix. `KA`, not `IN-KA`. */
  code: string;
  name: string;
}

/**
 * What this country calls the parts of an address.
 *
 * ⚠️ `region` IS NULLABLE AND THAT IS THE POINT. Singapore is a city-state; it
 *   has no second address level, so the field is not rendered rather than
 *   rendered empty. This is separate from `CountryInfo.regions`, which is the
 *   much narrower "does tax register per subdivision" question — Australia has
 *   states worth putting in an address and no state-level GST registration, so
 *   it has a `region` label and an empty `regions` list.
 */
export interface AddressLabels {
  addressLine1: string;
  city: string;
  region: string | null;
  postalCode: string;
}

export interface PostalFormat {
  /**
   * Anchored regex SOURCE, not a RegExp.
   *
   * A string so this stays a plain data table that serialises to the client,
   * and so nothing can share a stateful `lastIndex` with a `/g` flag. Compile
   * it at the point of use; `isValidPostalCode` is that point.
   */
  pattern: string;
  example: string;
  /** Digits only, so the field can be numeric and typing can strip the rest. */
  numeric: boolean;
}

export interface TaxIdFormat {
  /** What the clinic's paperwork calls it: GSTIN, VAT number, TRN, ABN. */
  label: string;
  pattern: string;
  example: string;
  /** Where the clinic would find it. Shown under the field. */
  hint: string;
}

export interface DialFormat {
  /** With the plus. `+91`. */
  code: string;
  /** National significant digits AFTER the calling code. */
  minDigits: number;
  maxDigits: number;
  /** An obviously-not-real number of the right length, for the placeholder. */
  example: string;
}

export interface CountryInfo {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  currency: string;
  timezones: readonly string[];
  /** Empty where no sub-national tax registration exists. */
  regions: readonly Region[];
  /**
   * The usual shape of a registration here, for prefilling only.
   *
   * `standardRateBps` is the headline rate on services at the time of writing.
   * Rates change by statute and this table is not a rate feed — an operator
   * confirms it against the registration certificate in front of them, which is
   * why the console shows it as a suggestion rather than filling it silently.
   */
  tax: { scheme: 'GST' | 'VAT' | 'SALES_TAX'; standardRateBps: number } | null;
  dial: DialFormat;
  labels: AddressLabels;
  /** Null where the country issues no postcodes at all — the UAE. */
  postal: PostalFormat | null;
  /** Null where there is no single national registration to ask for. */
  taxId: TaxIdFormat | null;
}

/** India's states and union territories, by ISO 3166-2 code. */
const INDIA_REGIONS: readonly Region[] = [
  { code: 'AN', name: 'Andaman and Nicobar Islands' },
  { code: 'AP', name: 'Andhra Pradesh' },
  { code: 'AR', name: 'Arunachal Pradesh' },
  { code: 'AS', name: 'Assam' },
  { code: 'BR', name: 'Bihar' },
  { code: 'CH', name: 'Chandigarh' },
  { code: 'CT', name: 'Chhattisgarh' },
  { code: 'DH', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: 'DL', name: 'Delhi' },
  { code: 'GA', name: 'Goa' },
  { code: 'GJ', name: 'Gujarat' },
  { code: 'HP', name: 'Himachal Pradesh' },
  { code: 'HR', name: 'Haryana' },
  { code: 'JH', name: 'Jharkhand' },
  { code: 'JK', name: 'Jammu and Kashmir' },
  { code: 'KA', name: 'Karnataka' },
  { code: 'KL', name: 'Kerala' },
  { code: 'LA', name: 'Ladakh' },
  { code: 'LD', name: 'Lakshadweep' },
  { code: 'MH', name: 'Maharashtra' },
  { code: 'ML', name: 'Meghalaya' },
  { code: 'MN', name: 'Manipur' },
  { code: 'MP', name: 'Madhya Pradesh' },
  { code: 'MZ', name: 'Mizoram' },
  { code: 'NL', name: 'Nagaland' },
  { code: 'OR', name: 'Odisha' },
  { code: 'PB', name: 'Punjab' },
  { code: 'PY', name: 'Puducherry' },
  { code: 'RJ', name: 'Rajasthan' },
  { code: 'SK', name: 'Sikkim' },
  { code: 'TG', name: 'Telangana' },
  { code: 'TN', name: 'Tamil Nadu' },
  { code: 'TR', name: 'Tripura' },
  { code: 'UP', name: 'Uttar Pradesh' },
  { code: 'UT', name: 'Uttarakhand' },
  { code: 'WB', name: 'West Bengal' },
];

/** US states that levy a sales tax, plus DC. The five that do not are omitted. */
const US_REGIONS: readonly Region[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];

export const COUNTRIES: readonly CountryInfo[] = [
  {
    code: 'IN',
    name: 'India',
    currency: 'INR',
    timezones: ['Asia/Kolkata'],
    regions: INDIA_REGIONS,
    tax: { scheme: 'GST', standardRateBps: 1800 },
    dial: { code: '+91', minDigits: 10, maxDigits: 10, example: '9876543210' },
    labels: {
      addressLine1: 'Street address',
      city: 'City',
      region: 'State',
      postalCode: 'PIN code',
    },
    // No PIN code starts with 0.
    postal: { pattern: '^[1-9]\\d{5}$', example: '411038', numeric: true },
    taxId: {
      label: 'GSTIN',
      pattern: '^\\d{2}[A-Z]{5}\\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$',
      example: '27AAAAA0000A1Z5',
      hint: 'Fifteen characters, from your GST registration certificate.',
    },
  },
  {
    code: 'AE',
    name: 'United Arab Emirates',
    currency: 'AED',
    timezones: ['Asia/Dubai'],
    regions: [],
    tax: { scheme: 'VAT', standardRateBps: 500 },
    dial: { code: '+971', minDigits: 8, maxDigits: 9, example: '501234567' },
    labels: {
      addressLine1: 'Street address',
      city: 'City',
      region: 'Emirate',
      postalCode: '',
    },
    // The UAE has no postcode system at all — PO boxes are not postcodes.
    postal: null,
    taxId: {
      label: 'TRN',
      pattern: '^\\d{15}$',
      example: '100123456700003',
      hint: 'Fifteen digits, from your FTA VAT registration.',
    },
  },
  {
    code: 'SG',
    name: 'Singapore',
    currency: 'SGD',
    timezones: ['Asia/Singapore'],
    regions: [],
    tax: { scheme: 'GST', standardRateBps: 900 },
    dial: { code: '+65', minDigits: 8, maxDigits: 8, example: '81234567' },
    labels: {
      addressLine1: 'Street address',
      city: 'City',
      // A city-state. There is no second level to ask for.
      region: null,
      postalCode: 'Postal code',
    },
    postal: { pattern: '^\\d{6}$', example: '188966', numeric: true },
    taxId: {
      label: 'GST registration number',
      pattern: '^[0-9A-Z]{8,11}$',
      example: 'M90312345A',
      hint: 'From your IRAS GST registration.',
    },
  },
  {
    code: 'AU',
    name: 'Australia',
    currency: 'AUD',
    timezones: [
      'Australia/Sydney',
      'Australia/Melbourne',
      'Australia/Brisbane',
      'Australia/Adelaide',
      'Australia/Perth',
      'Australia/Darwin',
      'Australia/Hobart',
    ],
    regions: [],
    tax: { scheme: 'GST', standardRateBps: 1000 },
    dial: { code: '+61', minDigits: 9, maxDigits: 9, example: '412345678' },
    labels: {
      addressLine1: 'Street address',
      city: 'Suburb',
      // States exist and belong in the address; GST does not register per
      // state, which is why `regions` above is empty. Both are true.
      region: 'State or territory',
      postalCode: 'Postcode',
    },
    postal: { pattern: '^\\d{4}$', example: '3000', numeric: true },
    taxId: {
      label: 'ABN',
      pattern: '^\\d{11}$',
      example: '51824753556',
      hint: 'Eleven digits, from your Australian Business Register listing.',
    },
  },
  {
    code: 'GB',
    name: 'United Kingdom',
    currency: 'GBP',
    timezones: ['Europe/London'],
    regions: [],
    tax: { scheme: 'VAT', standardRateBps: 2000 },
    dial: { code: '+44', minDigits: 9, maxDigits: 10, example: '7700900123' },
    labels: {
      addressLine1: 'Street address',
      city: 'Town or city',
      region: 'County',
      postalCode: 'Postcode',
    },
    postal: {
      pattern: '^[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2}$',
      example: 'SW1A 1AA',
      numeric: false,
    },
    taxId: {
      label: 'VAT number',
      pattern: '^GB(\\d{9}|\\d{12}|GD\\d{3}|HA\\d{3})$',
      example: 'GB123456789',
      hint: 'Starts with GB, from your VAT registration certificate.',
    },
  },
  {
    code: 'IE',
    name: 'Ireland',
    currency: 'EUR',
    timezones: ['Europe/Dublin'],
    regions: [],
    tax: { scheme: 'VAT', standardRateBps: 2300 },
    dial: { code: '+353', minDigits: 7, maxDigits: 9, example: '851234567' },
    labels: {
      addressLine1: 'Street address',
      city: 'Town or city',
      region: 'County',
      postalCode: 'Eircode',
    },
    postal: { pattern: '^[A-Z]\\d{2} ?[A-Z\\d]{4}$', example: 'D02 AF30', numeric: false },
    taxId: {
      label: 'VAT number',
      pattern: '^IE\\d{7}[A-Z]{1,2}$',
      example: 'IE1234567FA',
      hint: 'Starts with IE, from your Revenue VAT registration.',
    },
  },
  {
    code: 'NP',
    name: 'Nepal',
    currency: 'NPR',
    timezones: ['Asia/Kathmandu'],
    regions: [],
    tax: { scheme: 'VAT', standardRateBps: 1300 },
    dial: { code: '+977', minDigits: 9, maxDigits: 10, example: '9801234567' },
    labels: {
      addressLine1: 'Street address',
      city: 'City',
      region: 'Province',
      postalCode: 'Postal code',
    },
    postal: { pattern: '^\\d{5}$', example: '44600', numeric: true },
    taxId: {
      label: 'PAN',
      pattern: '^\\d{9}$',
      example: '123456789',
      hint: 'Nine digits, from your Inland Revenue registration.',
    },
  },
  {
    code: 'LK',
    name: 'Sri Lanka',
    currency: 'LKR',
    timezones: ['Asia/Colombo'],
    regions: [],
    tax: { scheme: 'VAT', standardRateBps: 1800 },
    dial: { code: '+94', minDigits: 9, maxDigits: 9, example: '771234567' },
    labels: {
      addressLine1: 'Street address',
      city: 'City',
      region: 'District',
      postalCode: 'Postal code',
    },
    postal: { pattern: '^\\d{5}$', example: '00100', numeric: true },
    taxId: {
      label: 'VAT number',
      pattern: '^\\d{9}(-?7000)?$',
      example: '123456789-7000',
      hint: 'Your TIN, with the VAT suffix if your certificate shows one.',
    },
  },
  {
    code: 'BD',
    name: 'Bangladesh',
    currency: 'BDT',
    timezones: ['Asia/Dhaka'],
    regions: [],
    tax: { scheme: 'VAT', standardRateBps: 1500 },
    dial: { code: '+880', minDigits: 10, maxDigits: 10, example: '1712345678' },
    labels: {
      addressLine1: 'Street address',
      city: 'City',
      region: 'District',
      postalCode: 'Post code',
    },
    postal: { pattern: '^\\d{4}$', example: '1000', numeric: true },
    taxId: {
      label: 'BIN',
      pattern: '^\\d{9}(-?\\d{4})?$',
      example: '000123456-0101',
      hint: 'From your NBR business identification certificate.',
    },
  },
  {
    code: 'US',
    name: 'United States',
    currency: 'USD',
    timezones: [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Phoenix',
      'America/Los_Angeles',
      'America/Anchorage',
      'Pacific/Honolulu',
    ],
    regions: US_REGIONS,
    /*
     * No prefill, deliberately. US sales tax is not one rate per state — rates
     * combine state, county, city and special districts, and whether SaaS is
     * taxable at all varies. A suggested number here would be wrong far more
     * often than right, on a screen whose whole risk is a plausible wrong
     * number. `resolveTax` refuses to compute it for the same reason.
     */
    tax: null,
    dial: { code: '+1', minDigits: 10, maxDigits: 10, example: '5555550123' },
    labels: {
      addressLine1: 'Street address',
      city: 'City',
      region: 'State',
      postalCode: 'ZIP code',
    },
    postal: { pattern: '^\\d{5}(-\\d{4})?$', example: '94107', numeric: false },
    /*
     * Null for the same reason `tax` is. There is no federal registration
     * number a clinic holds — a seller's permit is issued per state, and which
     * states a practice needs one in depends on where it has nexus. Asking for
     * "your tax number" on a signup form would collect something we could not
     * use and could not validate.
     */
    taxId: null,
  },
];

export function countryInfo(code: string | null | undefined): CountryInfo | undefined {
  if (!code) return undefined;
  const upper = code.toUpperCase();
  return COUNTRIES.find((country) => country.code === upper);
}

/** The zone to assume before anyone has chosen. */
export function defaultTimezoneFor(code: string | null | undefined): string {
  return countryInfo(code)?.timezones[0] ?? 'UTC';
}

/** Whether the customer has a decision to make about the zone. */
export function hasTimezoneChoice(code: string | null | undefined): boolean {
  return (countryInfo(code)?.timezones.length ?? 0) > 1;
}

/** The subdivisions worth asking about. Empty means country-wide only. */
export function regionsFor(code: string | null | undefined): readonly Region[] {
  return countryInfo(code)?.regions ?? [];
}

/** Whether a region code is one this country actually has. */
export function isValidRegion(countryCode: string, regionCode: string | null): boolean {
  if (!regionCode) return true;
  const regions = regionsFor(countryCode);
  // A country with no listed subdivisions accepts none — a region on Ireland is
  // a mistake, not a detail we happen not to list.
  return regions.some((region) => region.code === regionCode.toUpperCase());
}

/** What this country calls the parts of an address. Falls back to India's. */
export function addressLabels(code: string | null | undefined): AddressLabels {
  return countryInfo(code)?.labels ?? (COUNTRIES[0] as CountryInfo).labels;
}

/** The postcode format, or null where the country issues none. */
export function postalFormatFor(code: string | null | undefined): PostalFormat | null {
  return countryInfo(code)?.postal ?? null;
}

/** The tax registration to ask for, or null where there is no single one. */
export function taxIdFormatFor(code: string | null | undefined): TaxIdFormat | null {
  return countryInfo(code)?.taxId ?? null;
}

/** The calling code and national digit count. Falls back to India's. */
export function dialFormatFor(code: string | null | undefined): DialFormat {
  return countryInfo(code)?.dial ?? (COUNTRIES[0] as CountryInfo).dial;
}

/**
 * Whether a postcode is well formed for its country.
 *
 * Blank is VALID — the field is optional everywhere, and a country with no
 * postcode system has nothing to check. This answers "is what was typed
 * plausible", never "does this address exist".
 *
 * Case and internal spacing are normalised first, so `d02af30` passes for
 * Ireland; `normalizePostalCode` is what the form should store.
 */
export function isValidPostalCode(
  countryCode: string | null | undefined,
  value: string | null | undefined
): boolean {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return true;
  const format = postalFormatFor(countryCode);
  if (!format) return true;
  return new RegExp(format.pattern).test(normalizePostalCode(countryCode, trimmed));
}

/** Upper-cased, single-spaced. What we store and what we validate. */
export function normalizePostalCode(countryCode: string | null | undefined, value: string): string {
  const format = postalFormatFor(countryCode);
  const cleaned = value.trim().toUpperCase().replace(/\s+/g, ' ');
  return format?.numeric ? cleaned.replace(/[^0-9]/g, '') : cleaned;
}

/**
 * Whether a tax registration number is well formed for its country.
 *
 * Blank is valid: the number is optional at signup everywhere, and a clinic
 * below the registration threshold genuinely does not have one. A country with
 * no `taxId` format accepts anything short — see the United States, where the
 * form does not ask at all.
 */
export function isValidTaxId(
  countryCode: string | null | undefined,
  value: string | null | undefined
): boolean {
  const trimmed = (value ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!trimmed) return true;
  const format = taxIdFormatFor(countryCode);
  if (!format) return trimmed.length <= 32;
  return new RegExp(format.pattern).test(trimmed);
}

/**
 * National digits + country -> E.164, which is the only phone shape the rest of
 * the system accepts (see `phone` in common.ts).
 *
 * A leading trunk zero is dropped: people in the UK, Australia and Ireland
 * write their own numbers with one, and `+4407700900123` is not a number.
 */
export function toE164(countryCode: string | null | undefined, national: string): string {
  const digits = national.replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  return `${dialFormatFor(countryCode).code}${digits}`;
}

/**
 * The inverse, for putting a stored number back into a split field.
 *
 * Returns the country whose calling code matches — LONGEST code first, or
 * `+1` would claim every number and `+9` would claim India's. Unmatched
 * numbers keep their digits and report no country, so the field can still show
 * what is stored rather than blanking it.
 */
export function splitE164(value: string | null | undefined): {
  countryCode: string | null;
  national: string;
} {
  const trimmed = (value ?? '').trim();
  if (!trimmed.startsWith('+')) return { countryCode: null, national: trimmed.replace(/\D/g, '') };

  const byLongestCode = [...COUNTRIES].sort((a, b) => b.dial.code.length - a.dial.code.length);
  for (const country of byLongestCode) {
    if (trimmed.startsWith(country.dial.code)) {
      return {
        countryCode: country.code,
        national: trimmed.slice(country.dial.code.length).replace(/\D/g, ''),
      };
    }
  }
  return { countryCode: null, national: trimmed.slice(1).replace(/\D/g, '') };
}

/** `Asia/Kolkata` -> `Asia/Kolkata (GMT+5:30)`. Display only. */
export function timezoneLabel(zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    const offset = parts.find((part) => part.type === 'timeZoneName')?.value;
    return offset ? `${zone} (${offset})` : zone;
  } catch {
    // An unknown zone still renders as itself rather than throwing inside a
    // select. `timezone` in common.ts is what validates; this only labels.
    return zone;
  }
}
