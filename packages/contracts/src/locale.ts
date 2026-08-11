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
 *   `temperatureUnit`
 *                — what a nurse HERE writes a body temperature in. See the note
 *                  on the field; it is a display and data-entry unit only, never
 *                  a storage unit.
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

/**
 * A form of identity a patient can produce at the counter.
 *
 * ⚠️ THIS IS ABOUT THE **PATIENT**, NOT THE CLINIC — `TaxIdFormat` is the
 *   clinic's registration and has nothing to do with it.
 *
 * Kept in its own table rather than as another field on `CountryInfo` because
 * a country has ONE postcode format and ONE tax registration but SEVERAL
 * accepted IDs, and because a traveller produces a passport in a country that
 * is not theirs. `nationalIdTypesFor` therefore always ends with the
 * country-agnostic entries.
 */
export interface NationalIdFormat {
  /** Stored in `patients.national_id_type`. Stable — never re-label in place. */
  code: string;
  /** What the person at the counter calls it. */
  label: string;
  /**
   * Anchored regex SOURCE, checked against the NORMALISED value (see
   * `normalizeNationalId`), or null to accept anything up to `maxLength`.
   * Null is the honest answer for a passport: formats differ by issuer and a
   * guessed pattern rejects a real document.
   */
  pattern: string | null;
  /** An obviously-not-real value of the right shape, for the placeholder. */
  example: string;
  /**
   * The typing template, or null for a document with no fixed shape.
   *
   * ⚠️ THIS IS WHAT STOPS A THIRTEEN-DIGIT AADHAAR BEING TYPED AT ALL, and it is
   *   deliberately a separate field from `pattern`. A regex says whether a
   *   finished value is valid; it cannot say whether the NEXT keystroke is, and
   *   a form that only checks on submit lets somebody type twenty digits and
   *   then tells them off. The mask is consulted per character.
   *
   *   `9` a digit · `A` a letter · `*` either. Anything else is a literal and is
   *   inserted for the typist — which is also where the grouping comes from, so
   *   there is one description of a document's shape rather than two that can
   *   disagree.
   *
   * ⚠️ THE MASK AND THE PATTERN DIVIDE THE WORK; THEY ARE NOT THE SAME RULE.
   *   The mask owns SHAPE — how many characters, and whether each position is a
   *   digit or a letter. The pattern owns VALUE — that an Aadhaar starts 2–9,
   *   that an Emirates ID starts 784, that a NINO ends A–D. Value rules cannot
   *   go in a mask without fighting the typist: a `784` literal would be
   *   inserted for them and then eat the `784` they typed themselves.
   *
   *   So a pattern is allowed to be STRICTER than its mask, and usually is. The
   *   mask must never be stricter than the pattern, and must never admit MORE
   *   characters than `maxLength` — either way round produces a field that
   *   accepts what the API refuses, or refuses what it would accept.
   */
  mask: string | null;
  /**
   * Longest NORMALISED value, separators excluded. Enforced even where `mask`
   * is null — a variable-length document still has a ceiling, and without one
   * the column's own 64 characters become the only limit.
   */
  maxLength: number;
  /** Digits only, so the field can raise a numeric keypad. */
  numeric: boolean;
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
  /**
   * What a clinician in this country writes a body temperature in.
   *
   * ⚠️ A DATA-ENTRY AND DISPLAY UNIT ONLY. `appointment_vitals.temperature_c` is
   *   Celsius in every country and always will be: it is what WHO, every
   *   clinical paper, and FHIR/UCUM (`Cel`) — which ABDM builds on — record in,
   *   and a column whose unit depends on the row is a column nobody can trend,
   *   compare or export. The conversion happens at the edge, once, in
   *   `toCelsius`/`fromCelsius` below.
   *
   * ⚠️ AND IT IS NOT THE COUNTRY'S GENERAL UNIT. India is metric for everything
   *   else — weather, cooking, school physics — and Fahrenheit for body
   *   temperature alone. A clinical thermometer sold in India reads °F, an OPD
   *   chart says 98.6, and a nurse handed "37.2" stops to think. The same is
   *   true across the subcontinent and in the United States; everywhere else in
   *   this table records in Celsius.
   */
  temperatureUnit: TemperatureUnit;
}

/** How a body temperature is written down. Never how it is stored. */
export type TemperatureUnit = 'C' | 'F';

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
    temperatureUnit: 'F',
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
    temperatureUnit: 'C',
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
    temperatureUnit: 'C',
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
    temperatureUnit: 'C',
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
    temperatureUnit: 'C',
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
    temperatureUnit: 'C',
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
    temperatureUnit: 'F',
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
    temperatureUnit: 'F',
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
    temperatureUnit: 'F',
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
    temperatureUnit: 'F',
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

/**
 * Identity documents a patient may produce, by country.
 *
 * ⚠️ VALIDATION IS ADVISORY AND ALWAYS ESCAPABLE. The `nationalId` field on
 *   patients carries a comment saying a per-country regex would reject a
 *   foreign patient's passport and the desk would work around it by leaving the
 *   field blank — which is worse than an unchecked value, because a blank field
 *   loses the identity check entirely. That reasoning still stands, so:
 *
 *     - checking happens only for the type the desk explicitly CHOSE;
 *     - `PASSPORT` and `OTHER` have no pattern at all and are offered
 *       everywhere, so there is always a way to record a document that does not
 *       fit;
 *     - the type is what is stored, so a wrongly-formatted Aadhaar is a
 *       correctable data-entry error rather than an unidentifiable string.
 *
 * Not exhaustive per country — these are the documents a clinic reception
 * actually sees. Adding one is a row here and nothing else.
 */
const UNIVERSAL_IDS: readonly NationalIdFormat[] = [
  {
    code: 'PASSPORT',
    label: 'Passport',
    // Issuer-defined. See the warning above — a guessed pattern rejects reality.
    pattern: null,
    example: 'L1234567',
    mask: null,
    maxLength: 20,
    numeric: false,
  },
  {
    code: 'OTHER',
    label: 'Something else',
    pattern: null,
    example: '',
    mask: null,
    // The column's own width. Nothing is known about this document's shape.
    maxLength: 64,
    numeric: false,
  },
];

const NATIONAL_IDS: Readonly<Record<string, readonly NationalIdFormat[]>> = {
  IN: [
    {
      code: 'AADHAAR',
      label: 'Aadhaar',
      // 12 digits, never starting 0 or 1 — UIDAI reserves those.
      pattern: '^[2-9]\\d{11}$',
      example: '2345 6789 0123',
      mask: '9999 9999 9999',
      maxLength: 12,
      numeric: true,
    },
    {
      code: 'PAN',
      label: 'PAN',
      pattern: '^[A-Z]{5}\\d{4}[A-Z]$',
      example: 'ABCDE1234F',
      // Five letters, four digits, one letter — enforced as it is typed, which
      // is why `5678988899` can no longer be entered in a PAN field.
      mask: 'AAAAA9999A',
      maxLength: 10,
      numeric: false,
    },
    {
      code: 'VOTER_ID',
      label: 'Voter ID (EPIC)',
      pattern: '^[A-Z]{3}\\d{7}$',
      example: 'ABC1234567',
      mask: 'AAA9999999',
      maxLength: 10,
      numeric: false,
    },
    {
      code: 'DRIVING_LICENCE',
      label: 'Driving licence',
      // State-issued and inconsistently formatted; length is the only honest check.
      pattern: '^[A-Z0-9]{8,20}$',
      example: 'MH1220110012345',
      mask: null,
      maxLength: 20,
      numeric: false,
    },
  ],
  US: [
    {
      code: 'SSN',
      label: 'Social Security number',
      pattern: '^\\d{9}$',
      example: '123 45 6789',
      mask: '999 99 9999',
      maxLength: 9,
      numeric: true,
    },
    {
      code: 'DRIVING_LICENCE',
      label: 'Driver’s license',
      pattern: '^[A-Z0-9]{4,20}$',
      example: 'D1234567',
      mask: null,
      maxLength: 20,
      numeric: false,
    },
  ],
  GB: [
    {
      code: 'NHS_NUMBER',
      label: 'NHS number',
      pattern: '^\\d{10}$',
      example: '485 777 3456',
      mask: '999 999 9999',
      maxLength: 10,
      numeric: true,
    },
    {
      code: 'NINO',
      label: 'National Insurance number',
      pattern: '^[A-Z]{2}\\d{6}[A-D]$',
      example: 'QQ123456C',
      mask: 'AA999999A',
      maxLength: 9,
      numeric: false,
    },
    {
      code: 'DRIVING_LICENCE',
      label: 'Driving licence',
      pattern: '^[A-Z0-9]{16}$',
      example: 'MORGA657054SM9IJ',
      mask: '****************',
      maxLength: 16,
      numeric: false,
    },
  ],
  IE: [
    {
      code: 'PPSN',
      label: 'PPS number',
      // Seven digits, a check letter, and an optional second — so the tail is
      // variable and a fixed mask would refuse the eight-character form.
      pattern: '^\\d{7}[A-W][A-IW]?$',
      example: '1234567FA',
      mask: null,
      maxLength: 9,
      numeric: false,
    },
  ],
  AE: [
    {
      code: 'EMIRATES_ID',
      label: 'Emirates ID',
      pattern: '^784\\d{12}$',
      example: '784 1234 1234567 1',
      mask: '999 9999 9999999 9',
      maxLength: 15,
      numeric: true,
    },
  ],
  SG: [
    {
      code: 'NRIC',
      label: 'NRIC / FIN',
      pattern: '^[STFGM]\\d{7}[A-Z]$',
      example: 'S1234567D',
      mask: 'A9999999A',
      maxLength: 9,
      numeric: false,
    },
  ],
  AU: [
    {
      code: 'MEDICARE',
      label: 'Medicare card',
      // Ten digits, plus an optional issue number — variable, so no mask.
      pattern: '^\\d{10,11}$',
      example: '2123 45670 1',
      mask: null,
      maxLength: 11,
      numeric: true,
    },
    {
      code: 'DRIVING_LICENCE',
      label: 'Driver licence',
      pattern: '^[A-Z0-9]{4,12}$',
      example: '12345678',
      mask: null,
      maxLength: 12,
      numeric: false,
    },
  ],
  NP: [
    {
      code: 'CITIZENSHIP',
      label: 'Citizenship certificate',
      // District-issued, no national format. Length only.
      pattern: '^[A-Z0-9/-]{6,30}$',
      example: '12-34-56-78901',
      mask: null,
      maxLength: 30,
      numeric: false,
    },
    {
      code: 'NATIONAL_ID',
      label: 'National ID',
      pattern: '^\\d{9,12}$',
      example: '123456789',
      mask: null,
      maxLength: 12,
      numeric: true,
    },
  ],
  LK: [
    {
      code: 'NIC',
      label: 'NIC',
      // Both forms in circulation: the old 9+letter and the 2016 12-digit.
      pattern: '^(\\d{9}[VXvx]|\\d{12})$',
      example: '199012345678',
      mask: null,
      maxLength: 12,
      numeric: false,
    },
  ],
  BD: [
    {
      code: 'NID',
      label: 'National ID (NID)',
      pattern: '^(\\d{10}|\\d{13}|\\d{17})$',
      example: '1234567890',
      mask: null,
      maxLength: 17,
      numeric: true,
    },
  ],
};

/**
 * What this country's clinics may be shown an ID from, most common first, with
 * the country-agnostic documents last.
 *
 * An unknown country still gets passport and "something else", so the field is
 * never unusable.
 */
export function nationalIdTypesFor(code: string | null | undefined): readonly NationalIdFormat[] {
  const country = (code ?? '').toUpperCase();
  return [...(NATIONAL_IDS[country] ?? []), ...UNIVERSAL_IDS];
}

/** One ID format by country and type code, or null if that pairing is unknown. */
export function nationalIdFormatFor(
  countryCode: string | null | undefined,
  typeCode: string | null | undefined
): NationalIdFormat | null {
  if (!typeCode) return null;
  const wanted = typeCode.toUpperCase();
  return nationalIdTypesFor(countryCode).find((t) => t.code === wanted) ?? null;
}

/**
 * Strip the grouping so a stored value is comparable.
 *
 * `2345 6789 0123` and `2345-6789-0123` are the same Aadhaar, and a duplicate
 * check that treats them as different is a duplicate check that does nothing.
 * Upper-cased for the same reason.
 */
export function normalizeNationalId(value: string | null | undefined): string {
  return (value ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Is this ID plausible for the chosen type?
 *
 * Blank is VALID — the field is optional and a patient need not produce
 * anything. An unknown type is VALID too: see the warning on `NATIONAL_IDS`,
 * where refusing beats nothing and losing the value beats everything.
 */
export function isValidNationalId(
  countryCode: string | null | undefined,
  typeCode: string | null | undefined,
  value: string | null | undefined
): boolean {
  const normalized = normalizeNationalId(value);
  if (!normalized) return true;

  const format = nationalIdFormatFor(countryCode, typeCode);
  if (!format?.pattern) return true;

  return new RegExp(format.pattern).test(normalized);
}

/**
 * Does this character belong at this position of the mask?
 *
 * `9` digit · `A` letter · `*` either. Anything else is a literal separator and
 * is never matched against typed input — separators are inserted, not typed.
 */
function acceptsAt(maskChar: string, char: string): boolean {
  if (maskChar === '9') return /\d/.test(char);
  if (maskChar === 'A') return /[A-Z]/.test(char);
  if (maskChar === '*') return /[A-Z0-9]/.test(char);
  return false;
}

/**
 * Apply a document's mask to whatever has been typed so far.
 *
 * ⚠️ THE GATE IS PER CHARACTER, NOT PER FIELD, and that is the whole point.
 *   Returning the input unchanged and validating on submit is what let a
 *   thirteen-digit Aadhaar and a digits-only PAN be typed in the first place.
 *   A character that does not fit the next mask position is DROPPED — so the
 *   field simply stops accepting at twelve digits, and a letter typed into a
 *   digit slot never appears.
 *
 * Separators are inserted automatically as the value grows past them, so the
 * typist never types a space and pasting `2345-6789-0123` lands correctly.
 *
 * Returns the DISPLAY string, with separators. `normalizeNationalId` strips
 * them again for storage.
 */
export function applyNationalIdMask(
  countryCode: string | null | undefined,
  typeCode: string | null | undefined,
  value: string
): string {
  const format = nationalIdFormatFor(countryCode, typeCode);
  const source = normalizeNationalId(value);

  if (!format) return source.slice(0, 64);

  /*
   * No mask: a document whose shape genuinely varies (a passport, an Indian
   * driving licence). Still capped, and still restricted to digits where the
   * document is numeric — an unbounded field is how 64 characters of nonsense
   * gets stored.
   */
  if (!format.mask) {
    const cleaned = format.numeric ? source.replace(/\D/g, '') : source;
    return cleaned.slice(0, format.maxLength);
  }

  let out = '';
  let at = 0;

  for (const maskChar of format.mask) {
    if (at >= source.length) break;

    if (maskChar === '9' || maskChar === 'A' || maskChar === '*') {
      // Skip anything that cannot go here rather than stopping: a pasted value
      // with stray punctuation should land, not truncate at the first oddity.
      while (at < source.length && !acceptsAt(maskChar, source[at] as string)) at += 1;
      if (at >= source.length) break;
      out += source[at];
      at += 1;
    } else {
      out += maskChar;
    }
  }

  return out;
}

/**
 * Regroup a stored value for display: `234567890123` -> `2345 6789 0123`.
 *
 * The same masking, which is why there is only one description of a document's
 * shape in this file.
 */
export function formatNationalId(
  countryCode: string | null | undefined,
  typeCode: string | null | undefined,
  value: string | null | undefined
): string {
  return applyNationalIdMask(countryCode, typeCode, value ?? '');
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

// ---------------------------------------------------------------------------
// Body temperature
// ---------------------------------------------------------------------------

/**
 * ⚠️ CELSIUS IS THE STORAGE UNIT IN EVERY COUNTRY, AND NOTHING BELOW CHANGES
 *   THAT. `appointment_vitals.temperature_c` holds Celsius for an Indian clinic
 *   and a British one alike, because a column whose unit depends on the row is a
 *   column that cannot be trended, compared, range-checked or exported — and
 *   because FHIR/UCUM `Cel`, which ABDM builds on, is what a reading has to
 *   leave the system as.
 *
 *   What varies is what the nurse TYPES and what the chart SHOWS. These four
 *   functions are the only place the two meet, so there is exactly one
 *   conversion in the product and it is tested.
 */

/** Decimal places `temperature_c` is stored at — `Decimal(4, 2)`, so 0.01 °C. */
const CELSIUS_PLACES = 100;

export function temperatureUnitFor(code: string | null | undefined): TemperatureUnit {
  /*
   * Celsius for an unknown country, deliberately: it is the storage unit, so
   * the fallback is the case where entry and storage agree and no conversion
   * can be got wrong. Guessing Fahrenheit would make a missing country code
   * silently multiply every reading.
   */
  return countryInfo(code)?.temperatureUnit ?? 'C';
}

/** `°C` or `°F`, for a label. */
export function temperatureSymbol(unit: TemperatureUnit): string {
  return unit === 'F' ? '°F' : '°C';
}

/**
 * What the clinician typed → Celsius, rounded to how it will be stored.
 *
 * ⚠️ THE ROUNDING IS DONE HERE, NOT LEFT TO POSTGRES, so that what comes back
 *   out of `fromCelsius` is what was typed in. 99.4°F is 37.444…°C; stored at
 *   two decimals that is 37.44, which reads back as 99.39 → 99.4. At the ONE
 *   decimal the column originally had it would have stored 37.4 and read back
 *   99.3 — a nurse typing 99.4 and seeing 99.3 on the chart a second later.
 *   That is why the column is `Decimal(4, 2)`.
 */
export function toCelsius(value: number, unit: TemperatureUnit): number {
  const celsius = unit === 'F' ? ((value - 32) * 5) / 9 : value;
  return Math.round(celsius * CELSIUS_PLACES) / CELSIUS_PLACES;
}

/** Celsius as stored → what this country reads it in. */
export function fromCelsius(celsius: number, unit: TemperatureUnit): number {
  const value = unit === 'F' ? (celsius * 9) / 5 + 32 : celsius;
  // One decimal is finer than any clinical thermometer resolves, in either unit.
  return Math.round(value * 10) / 10;
}

/*
 * ⚠️ `temperatureRangeFor` LIVES IN appointments.ts, NOT HERE, and deliberately.
 *   The survivable range is a clinical fact that belongs beside the other eight
 *   in `VITAL_RANGES`; only the UNIT is a country fact. This file would
 *   otherwise own half of one table.
 */

// ---------------------------------------------------------------------------
// Clock face
// ---------------------------------------------------------------------------

/**
 * WHETHER A CLINIC READS ITS DIARY AS `4:40 pm` OR `16:40`.
 *
 * ⚠️ THIS IS A DISPLAY CHOICE AND NOTHING ELSE. Every instant in this system is
 *   stored in UTC — `timestamptz` in Postgres, an ISO string with a `Z` on the
 *   wire — and rendered in the branch's IANA zone. This decides only the shape
 *   of the clock face on top of that. It never touches storage, never touches
 *   arithmetic, and is never parsed back out of a string.
 *
 * ⚠️ IT IS A SETTING BECAUSE THE ANSWER IS NOT UNIVERSAL. rcln pinned 24-hour
 *   everywhere on the reasoning that a clinic diary is read as "16:40"; that is
 *   true of a hospital in the UK and false of most Indian outpatient clinics,
 *   where the appointment card says 4:40 pm and the staff read it back that way.
 *   Getting it wrong is not a crash, it is a receptionist double-checking every
 *   afternoon slot. `12H` is the default for that reason.
 *
 * Resolved from `locale.time_format` (ORGANIZATION or BRANCH scope), because a
 * group can run a hospital wing and a walk-in clinic with different habits.
 */
export const TIME_FORMATS = ['12H', '24H'] as const;

export type TimeFormat = (typeof TIME_FORMATS)[number];

/** What a clinic gets before anybody chooses. Must match the seeded default. */
export const DEFAULT_TIME_FORMAT: TimeFormat = '12H';

/**
 * Anything at all -> a format that is safe to render.
 *
 * ⚠️ THE FALLBACK IS THE DEFAULT, NOT A THROW. This value arrives from a JSON
 *   settings column that a migration or a hand-written row could leave holding
 *   anything. A clock that renders in the wrong shape is a cosmetic complaint;
 *   an appointment board that throws during render because a setting is `null`
 *   is a clinic that cannot see its day.
 */
export function toTimeFormat(value: unknown): TimeFormat {
  return value === '24H' || value === '12H' ? value : DEFAULT_TIME_FORMAT;
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
