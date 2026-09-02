/**
 * The decode half of PI-23: one scanned string in, the identifiers it carries
 * out. Pure, synchronous, and it touches no database — resolving what those
 * identifiers MEAN is `resolve.service.ts`'s job in `apps/api`, and keeping the
 * two apart is what lets the decoder be tested exhaustively against printed
 * barcodes rather than against a seeded clinic.
 *
 * ⚠️ WHY THIS IS IN `@rcln/inventory` AND NOT IN THE API. Goods receipt, the
 *   dispensing counter and the recall scope screen all scan, and PI-4's receipt
 *   posting already runs partly in the worker. A decoder living in `apps/api`
 *   would be re-implemented the first time anything outside it had to read a
 *   pack — and a SECOND barcode parser that disagrees about a century is exactly
 *   the defect class this file's comments are about.
 *
 * ── WHAT A SCAN ACTUALLY IS ─────────────────────────────────────────────────
 * A retail EAN-13 is thirteen digits and says one thing: which trade item. Every
 * medicine pack a clinic receives today carries a GS1 DataMatrix instead, whose
 * payload is an ELEMENT STRING: a run of (application identifier, value) pairs
 * with no separator between them at all. `010890123456789017271231102ABC` is a
 * GTIN, an expiry and a lot number, and the only reason it can be taken apart is
 * that the reader knows AI `01` is followed by exactly fourteen digits and AI
 * `17` by exactly six.
 *
 * ⚠️ WHICH IS WHY AN UNKNOWN AI STOPS THE PARSE INSTEAD OF BEING SKIPPED.
 *   There is no way to know how many characters an unknown AI consumes, so
 *   "skip it and carry on" resumes reading in the MIDDLE of somebody's data and
 *   produces a lot number that looks entirely plausible and is not the one on
 *   the box. The remainder is handed back verbatim in `unparsed` with a warning,
 *   and the screen shows the operator what could not be read. Refusing to guess
 *   is the whole safety property of this file.
 *
 * ⚠️ AND WHY A VARIABLE-LENGTH AI NEEDS FNC1. AI `10` (lot) runs to twenty
 *   characters or to the next FNC1, whichever comes first. Scanners transmit
 *   FNC1 as ASCII 29 (GS), and a great many are configured not to transmit it at
 *   all — so a payload whose lot is followed by anything else arrives ambiguous.
 *   This decoder reads to the end of the string in that case, which is the only
 *   reading that is ever safe: a lot that swallowed a trailing serial is visibly
 *   wrong to the person holding the box, whereas a lot silently truncated at
 *   twenty characters is not.
 *
 * NO PHI. A barcode names a product, a lot and a device — never a person.
 */

/** ASCII 29. FNC1 on the wire, whatever the symbology. */
const GS = '\u001D';

/**
 * The separators scanners emit besides the real one. Keyboard-wedge readers
 * routinely cannot type ASCII 29 and substitute a printable stand-in; `␝`
 * is the Unicode SYMBOL FOR GROUP SEPARATOR, which some emit verbatim.
 */
const SEPARATOR_ALIASES: readonly string[] = ['␝', '<GS>', '{GS}'];

/**
 * Symbology identifiers, prefixed by the READER rather than encoded in the
 * barcode. `]d2` is a GS1 DataMatrix, `]C1` a GS1-128, `]Q3` a GS1 QR, `]e0` a
 * GS1 DataBar. Left in place they become part of the first AI.
 */
const SYMBOLOGY_IDENTIFIER = /^\](?:d2|d1|C1|C0|Q3|Q1|e0|E0|E4|X0)/;

export type ScanFormat =
  /** An element string: one or more (AI, value) pairs. */
  | 'GS1'
  /** Bare digits that scan as a trade item — EAN-13, UPC-A, GTIN-8, GTIN-14. */
  | 'GTIN'
  /** Anything else. A clinic's own SKU, a shelf label, a hand-typed lot. */
  | 'PLAIN';

export type ScanWarning =
  /** The GTIN's mod-10 check digit does not match its digits. */
  | 'CHECK_DIGIT_FAILED'
  /** An AI this decoder does not know. Everything from it on is `unparsed`. */
  | 'UNKNOWN_APPLICATION_IDENTIFIER'
  /** A fixed-length element ran off the end of the string. */
  | 'TRUNCATED_ELEMENT'
  /** A date element that is not a real calendar date. */
  | 'INVALID_DATE'
  /** A numeric-only element carrying something that is not a digit. */
  | 'NON_NUMERIC_DATA'
  /**
   * A variable-length field ran past its own maximum with no FNC1 to end it, so
   * it has certainly swallowed whatever followed. See `parseElementString`.
   */
  | 'AMBIGUOUS_VARIABLE_LENGTH';

export interface Gs1Element {
  /** The application identifier, as printed: `01`, `17`, `7003`. */
  ai: string;
  /** What it is, in the words a storekeeper would use. */
  label: string;
  /** The characters that followed it, exactly as scanned. */
  value: string;
}

export interface DecodedScan {
  format: ScanFormat;
  /** What was scanned, minus the reader's symbology prefix. */
  raw: string;
  /**
   * Normalised to fourteen digits, which is the only form two GTINs can be
   * compared in. See `gtinVariants` for why the search still needs the others.
   */
  gtin: string | null;
  /**
   * Every form of the GTIN a catalogue might legitimately hold it in, longest
   * first. ⚠️ A CLINIC TYPES THE THIRTEEN DIGITS PRINTED UNDER THE BARS AND THE
   *   DATAMATRIX CARRIES FOURTEEN WITH A LEADING ZERO — matching on one form
   *   alone is a barcode that resolves nothing and a storekeeper who reports
   *   that "the scanner does not work for this product".
   */
  gtinCandidates: readonly string[];
  lotNumber: string | null;
  serialNumber: string | null;
  /** `YYYY-MM-DD`. AI 17, falling back to AI 15 for a pack dated best-before. */
  expiresOn: string | null;
  producedOn: string | null;
  /** AI 30 — how many are in the pack, for a variable-count trade item. */
  quantity: string | null;
  elements: readonly Gs1Element[];
  /**
   * Whatever the decoder refused to read on, verbatim. `null` when it read the
   * whole payload. Never silently dropped — the screen shows it.
   */
  unparsed: string | null;
  warnings: readonly ScanWarning[];
}

interface AiSpec {
  readonly label: string;
  /** A number = fixed length, no FNC1 follows. `null` = variable. */
  readonly length: number | null;
  /** The upper bound on a variable-length value. */
  readonly max: number;
  readonly numeric: boolean;
}

const fixed = (label: string, length: number, numeric = true): AiSpec => ({
  label,
  length,
  max: length,
  numeric,
});

const variable = (label: string, max: number, numeric = false): AiSpec => ({
  label,
  length: null,
  max,
  numeric,
});

/**
 * The application identifiers a clinic's stock actually carries.
 *
 * ⚠️ DELIBERATELY NOT THE WHOLE GS1 GENERAL SPECIFICATIONS. The full list runs
 *   to about 150 entries, most of them logistics and none of them ever printed
 *   on a medicine pack, and a table copied wholesale is a table nobody checked.
 *   What is here is the healthcare set (the four the FDA UDI and the EU FMD
 *   require, plus the national reimbursement numbers), the dates, the measures,
 *   and the logistics AIs that appear on an outer case. Anything else stops the
 *   parse loudly rather than being read wrongly — see the file header.
 */
const AIS: Readonly<Record<string, AiSpec>> = {
  '00': fixed('Pallet (SSCC)', 18),
  '01': fixed('GTIN', 14),
  '02': fixed('GTIN of the items inside', 14),
  '10': variable('Lot or batch number', 20),
  '11': fixed('Production date', 6),
  '12': fixed('Due date', 6),
  '13': fixed('Packaging date', 6),
  '15': fixed('Best before', 6),
  '16': fixed('Sell by', 6),
  '17': fixed('Expiry date', 6),
  '20': fixed('Internal product variant', 2),
  '21': variable('Serial number', 20),
  '22': variable('Consumer product variant', 20),
  '30': variable('Count of items', 8, true),
  '37': variable('Count of trade items', 8, true),
  '240': variable('Additional product identifier', 30),
  '241': variable('Customer part number', 30),
  '242': variable('Made-to-order variant', 6, true),
  '243': variable('Packaging component number', 20),
  '250': variable('Secondary serial number', 30),
  '251': variable('Reference to the source', 30),
  '253': variable('Document identifier (GDTI)', 30),
  '254': variable('Location extension', 20),
  '255': variable('Coupon (GCN)', 25, true),
  '400': variable("Customer's order number", 30),
  '401': variable('Consignment (GINC)', 30),
  '402': fixed('Shipment (GSIN)', 17),
  '403': variable('Routing code', 30),
  '410': fixed('Ship to (GLN)', 13),
  '411': fixed('Bill to (GLN)', 13),
  '412': fixed('Purchased from (GLN)', 13),
  '413': fixed('Ship for (GLN)', 13),
  '414': fixed('Physical location (GLN)', 13),
  '415': fixed('Invoicing party (GLN)', 13),
  '416': fixed('Production location (GLN)', 13),
  '417': fixed('Party (GLN)', 13),
  '422': fixed('Country of origin', 3),
  '424': fixed('Country of processing', 3),
  '426': fixed('Country covering the whole process', 3),
  '7001': fixed('NATO stock number', 13),
  '7003': fixed('Expiry date and time', 10),
  '7004': variable('Active potency', 4, true),
  '7006': fixed('First freeze date', 6),
  /*
   * ⚠️ THE NATIONAL HEALTHCARE REIMBURSEMENT NUMBERS, AND THE REASON THEY ARE
   *   NOT TREATED AS GTINs. A German PZN, a French CIP and a Spanish CN are
   *   NATIONAL codes, and PI-1 gave `product_identifiers` a `country_code`
   *   column precisely because two countries assign the same digits to different
   *   medicines. They travel as elements and are resolved country-qualified, or
   *   they are not resolved at all.
   */
  '710': variable('National reimbursement number (DE)', 20),
  '711': variable('National reimbursement number (FR)', 20),
  '712': variable('National reimbursement number (ES)', 20),
  '713': variable('National reimbursement number (BR)', 20),
  '714': variable('National reimbursement number (PT)', 20),
  '715': variable('National reimbursement number (US)', 20),
  '8017': fixed('Service relation, provider (GSRN)', 18),
  '8018': fixed('Service relation, recipient (GSRN)', 18),
  '8019': variable('Service relation instance', 10, true),
  '8200': variable('Product web page', 70),
};

/** The measure family: `31nn`–`36nn`, six digits, the last AI digit a decimal place. */
const MEASURE_PREFIXES: readonly string[] = ['31', '32', '33', '34', '35', '36'];

function measureSpec(ai: string): AiSpec | null {
  if (ai.length !== 4) return null;
  if (!MEASURE_PREFIXES.includes(ai.slice(0, 2))) return null;
  return fixed('Measurement', 6);
}

function specFor(ai: string): AiSpec | null {
  return AIS[ai] ?? measureSpec(ai);
}

/**
 * The AI at `from`, longest match first.
 *
 * ⚠️ LONGEST FIRST IS LOAD-BEARING. `7003` begins with `70`, which is not an AI,
 *   but `7004` and `71x` sit next to `710`–`715`, and `30` sits next to nothing
 *   while `300` would be read out of `3003…` by a shortest-match reader. Four,
 *   then three, then two, and nothing at all if none of them is known.
 */
function readAi(payload: string, from: number): string | null {
  for (const width of [4, 3, 2]) {
    const candidate = payload.slice(from, from + width);
    if (candidate.length === width && specFor(candidate) !== null) return candidate;
  }
  return null;
}

/**
 * The GS1 mod-10 check digit over a numeric string whose LAST character is the
 * check digit.
 *
 * Weights alternate 3,1 from the RIGHT, ignoring the check digit itself — which
 * makes the weighting depend on the string's LENGTH, so this cannot be written
 * as a fixed alternation from the left without getting GTIN-12 and GTIN-13
 * opposite ways round.
 */
export function hasValidCheckDigit(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  const body = digits.slice(0, -1);
  const stated = Number(digits.slice(-1));
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[body.length - 1 - i];
    if (char === undefined) return false;
    sum += Number(char) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === stated;
}

/** Left-pad to fourteen digits. The only form two GTINs are comparable in. */
export function normaliseGtin(value: string): string | null {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return null;
  return value.padStart(14, '0');
}

/**
 * Every form of one GTIN a catalogue might hold it in, longest first.
 *
 * ⚠️ THE LEADING ZEROS ARE NOT NOISE AND STRIPPING ALL OF THEM WOULD BE WRONG. A
 *   GTIN-14 whose leading digit is a real packaging indicator (`1`–`8`) is a
 *   DIFFERENT trade item from the GTIN-13 inside it — a case of twelve, not one
 *   box — so only ZEROS come off, and only down to the four lengths GS1 defines.
 *   `01234567890128` (indicator 0) yields the 14 and the 13 and stops there,
 *   because its second digit is not a zero; `10012345678902` (indicator 1)
 *   yields only itself, because a case is not the box inside it.
 */
export function gtinVariants(gtin: string): string[] {
  const full = normaliseGtin(gtin);
  if (full === null) return [];
  const out: string[] = [full];
  for (const width of [13, 12, 8]) {
    const pad = full.length - width;
    if (full.slice(0, pad) === '0'.repeat(pad)) out.push(full.slice(pad));
  }
  return out;
}

/**
 * `YYMMDD` to a calendar date.
 *
 * ⚠️ THE CENTURY IS INFERRED, AND GETTING THE WINDOW WRONG IS THE WORST DEFECT
 *   THIS FILE COULD CARRY. GS1 defines the range as 49 years back and 50 years
 *   forward from the current year, so `27` read in 2026 is 2027 and `77` is
 *   1977. A naive `2000 + yy` works perfectly until 2050 and then dates every
 *   pack fifty years in the past — every lot in the country expired, on the same
 *   morning. A naive `1900 + yy` refuses good stock today.
 *
 * ⚠️ AND `DD = 00` MEANS THE END OF THE MONTH, WHICH IS NOT A NICETY. GS1
 *   permits it and manufacturers use it constantly — most cartons print
 *   `EXP 01/2027` and encode `270100`. Reading day zero as invalid refuses a
 *   correctly printed pack; reading it as the 1st expires the stock a month
 *   early, and that is a whole month of a controlled drug that cannot be
 *   dispensed.
 */
export function decodeGs1Date(value: string, now: Date = new Date()): string | null {
  if (!/^\d{6}$/.test(value)) return null;
  const yy = Number(value.slice(0, 2));
  const mm = Number(value.slice(2, 4));
  const dd = Number(value.slice(4, 6));
  if (mm < 1 || mm > 12 || dd > 31) return null;

  const currentYear = now.getUTCFullYear();
  let year = Math.floor(currentYear / 100) * 100 + yy;
  if (year - currentYear > 50) year -= 100;
  else if (year - currentYear < -49) year += 100;

  // Day 0 = the last day of THIS month, which is day 0 of the next one in UTC.
  const day = dd === 0 ? new Date(Date.UTC(year, mm, 0)).getUTCDate() : dd;
  // A real calendar day, so 31 February is refused rather than rolling into March.
  const probe = new Date(Date.UTC(year, mm - 1, day));
  if (probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== day) return null;

  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(mm, 2)}-${pad(day, 2)}`;
}

function stripPrefixes(input: string): string {
  let s = input.trim().replace(SYMBOLOGY_IDENTIFIER, '');
  for (const alias of SEPARATOR_ALIASES) s = s.split(alias).join(GS);
  return s;
}

interface ParseOutcome {
  elements: Gs1Element[];
  unparsed: string | null;
  warnings: ScanWarning[];
}

/**
 * The human-readable form, `(01)08901234567890(17)271231(10)AB12`.
 *
 * Printed under every DataMatrix, and the form somebody types when the reader is
 * broken — which is the day this path earns its keep. Brackets are NEVER in the
 * encoded payload; they are the printed representation. So the two forms are
 * parsed separately rather than by stripping brackets and pretending.
 */
function parseBracketed(payload: string): ParseOutcome {
  const elements: Gs1Element[] = [];
  const warnings: ScanWarning[] = [];

  for (const match of payload.matchAll(/\((\d{2,4})\)([^(]*)/g)) {
    const ai = match[1] ?? '';
    const value = match[2] ?? '';
    const spec = specFor(ai);
    if (spec === null) {
      warnings.push('UNKNOWN_APPLICATION_IDENTIFIER');
      elements.push({ ai, label: 'Unrecognised', value });
      continue;
    }
    if (spec.numeric && !/^\d*$/.test(value)) warnings.push('NON_NUMERIC_DATA');
    if (spec.length !== null && value.length !== spec.length) warnings.push('TRUNCATED_ELEMENT');
    if (spec.length === null && value.length > spec.max) warnings.push('TRUNCATED_ELEMENT');
    elements.push({ ai, label: spec.label, value });
  }

  return { elements, unparsed: null, warnings };
}

function parseElementString(payload: string): ParseOutcome {
  const elements: Gs1Element[] = [];
  const warnings: ScanWarning[] = [];
  const hasSeparator = payload.includes(GS);
  let i = 0;

  while (i < payload.length) {
    if (payload[i] === GS) {
      i += 1;
      continue;
    }

    const ai = readAi(payload, i);
    const spec = ai === null ? null : specFor(ai);
    if (ai === null || spec === null) {
      warnings.push('UNKNOWN_APPLICATION_IDENTIFIER');
      return { elements, unparsed: payload.slice(i), warnings };
    }
    i += ai.length;

    let value: string;
    if (spec.length !== null) {
      value = payload.slice(i, i + spec.length);
      if (value.length < spec.length) warnings.push('TRUNCATED_ELEMENT');
      i += spec.length;
    } else {
      const end = payload.indexOf(GS, i);
      /*
       * ⚠️ TO THE SEPARATOR, OR TO THE END — AND NEVER TO `spec.max`. Cutting a
       *   lot at its twenty-character maximum when no FNC1 arrived would produce
       *   a lot number that is a plausible PREFIX of the real one, would match
       *   nothing, and would look correct on the screen. Reading to the end
       *   produces something visibly wrong to whoever is holding the box.
       */
      value = end === -1 ? payload.slice(i) : payload.slice(i, end);
      i = end === -1 ? payload.length : end + 1;

      /*
       * ⚠️ OVER ITS OWN MAXIMUM IS THE ONE AMBIGUITY THAT CAN BE PROVED. A lot is
       *   twenty characters at most, so a thirty-character one has certainly
       *   eaten the element after it — and with no FNC1 in the payload there is
       *   nothing to say where the boundary was. Note that a field ending at the
       *   end of the payload is NOT suspicious on its own: `01…17…10LOT` is the
       *   ordinary shape of a medicine DataMatrix and warning on it would make
       *   the warning meaningless.
       */
      if (value.length > spec.max) {
        warnings.push(
          end === -1 && !hasSeparator ? 'AMBIGUOUS_VARIABLE_LENGTH' : 'TRUNCATED_ELEMENT'
        );
      }
    }

    if (spec.numeric && !/^\d*$/.test(value)) warnings.push('NON_NUMERIC_DATA');
    elements.push({ ai, label: spec.label, value });
  }

  return { elements, unparsed: null, warnings };
}

const valueOf = (elements: readonly Gs1Element[], ai: string): string | null =>
  elements.find((e) => e.ai === ai)?.value ?? null;

const EMPTY: DecodedScan = {
  format: 'PLAIN',
  raw: '',
  gtin: null,
  gtinCandidates: [],
  lotNumber: null,
  serialNumber: null,
  expiresOn: null,
  producedOn: null,
  quantity: null,
  elements: [],
  unparsed: null,
  warnings: [],
};

/**
 * Decode one scanned or typed string.
 *
 * Never throws and never refuses: a value it cannot make sense of comes back as
 * `PLAIN` with the raw text intact, because "this is not a barcode I know" and
 * "this is a clinic's own SKU" are the same string, and the resolver behind this
 * tries both.
 *
 * `now` is injected so the century window is testable — see `decodeGs1Date`.
 */
export function decodeScan(input: string, now: Date = new Date()): DecodedScan {
  const raw = stripPrefixes(input);
  if (raw === '') return EMPTY;

  /*
   * Bare digits of a GTIN length, with no AI in front: the retail case, and also
   * what somebody types off the back of a box. Tried FIRST, because `01` is a
   * valid AI and a fourteen-digit GTIN beginning `01` would otherwise be read as
   * AI 01 carrying a twelve-digit, truncated value.
   */
  const asGtin = normaliseGtin(raw);
  if (asGtin !== null) {
    return {
      ...EMPTY,
      format: 'GTIN',
      raw,
      gtin: asGtin,
      gtinCandidates: gtinVariants(asGtin),
      elements: [{ ai: '01', label: 'GTIN', value: asGtin }],
      warnings: hasValidCheckDigit(raw) ? [] : ['CHECK_DIGIT_FAILED'],
    };
  }

  const outcome = raw.includes('(') ? parseBracketed(raw) : parseElementString(raw);

  if (outcome.elements.length === 0) {
    // Nothing recognised at all — a SKU, a shelf label, a hand-written lot.
    return { ...EMPTY, format: 'PLAIN', raw };
  }

  const warnings = [...outcome.warnings];
  const gtinRaw = valueOf(outcome.elements, '01');
  const gtin = gtinRaw === null ? null : normaliseGtin(gtinRaw);
  if (gtinRaw !== null && (gtin === null || !hasValidCheckDigit(gtinRaw))) {
    warnings.push('CHECK_DIGIT_FAILED');
  }

  const expiryRaw = valueOf(outcome.elements, '17') ?? valueOf(outcome.elements, '15');
  const expiresOn = expiryRaw === null ? null : decodeGs1Date(expiryRaw, now);
  const producedRaw = valueOf(outcome.elements, '11');
  const producedOn = producedRaw === null ? null : decodeGs1Date(producedRaw, now);
  if ((expiryRaw !== null && expiresOn === null) || (producedRaw !== null && producedOn === null)) {
    warnings.push('INVALID_DATE');
  }

  return {
    format: 'GS1',
    raw,
    gtin,
    gtinCandidates: gtin === null ? [] : gtinVariants(gtin),
    lotNumber: valueOf(outcome.elements, '10'),
    serialNumber: valueOf(outcome.elements, '21'),
    expiresOn,
    producedOn,
    quantity: valueOf(outcome.elements, '30'),
    elements: outcome.elements,
    unparsed: outcome.unparsed,
    warnings,
  };
}
