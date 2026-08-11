/**
 * Postcode -> city and region, for whichever country the form is in.
 *
 * ⚠️ SHARED BY THE CLINIC SIGNUP FORM AND THE PATIENT REGISTRATION FORM, which
 *   is why it lives here rather than in either one's `actions.ts`. The front
 *   desk types a PIN code for a patient exactly as the clinic typed one for
 *   itself, and two implementations of this would drift — the India-vs-rest
 *   split below is a real judgement call, not boilerplate to copy.
 *
 * NOT a `'use server'` module. These are ordinary async functions; each caller
 * re-exports the one it needs as its own Server Action, so no third party is
 * ever reachable from the browser and the action boundary stays where the form
 * is.
 */
import { isValidPostalCode, normalizePostalCode, regionsFor } from '@rcln/contracts';

/**
 * What a postcode told us about where it is. Every field optional — a lookup
 * that resolves the state but not the city is still worth having.
 */
export interface PostalLookup {
  city?: string;
  /** The display name, for the free-text region field. */
  region?: string;
  /** The ISO 3166-2 code, only where this country registers tax per region. */
  regionCode?: string;
}

/** How long we will wait for a third party before giving up and letting the customer type. */
const LOOKUP_TIMEOUT_MS = 4000;

/*
 * ⚠️ TWO THIRD-PARTY LOOKUPS, AND THE SPLIT IS DELIBERATE.
 *
 *   `api.postalpincode.in` is India Post's own data and answers with a real
 *   DISTRICT — "Pune" for 411038. Zippopotam answers the same PIN with the
 *   post office's name, "Bhusari Colony", which is not a city and is not what
 *   anyone would put on an invoice. India is the primary market, so it gets
 *   the source that is right rather than the one that is uniform.
 *
 *   Zippopotam covers the rest: US, GB, AU and BD in our list. IE, SG and NP
 *   are not in its data and AE has no postcodes, so those countries simply
 *   never autofill — the fields stay typed by hand, which is why this function
 *   returning null is an ordinary outcome and not an error.
 *
 * NEITHER IS TRUSTED AND NEITHER BLOCKS. This runs on the server rather than in
 * the browser so no customer's address ever reaches a third party from their
 * own machine, the responses are cached, and a hang cannot wedge the form. The
 * fields it fills stay editable: this is a convenience, and the customer is the
 * authority on their own address.
 */
export async function lookupPostalCode(
  countryCode: string,
  postalCode: string
): Promise<PostalLookup | null> {
  const country = countryCode.toUpperCase();
  const normalized = normalizePostalCode(country, postalCode);
  if (!normalized || !isValidPostalCode(country, normalized)) return null;

  try {
    const found =
      country === 'IN'
        ? await lookupIndiaPost(normalized)
        : await lookupZippopotam(country, normalized);
    if (!found) return null;

    /*
     * Map the returned region onto OUR region table where the country has one,
     * so the select lands on a real option. Zippopotam's US abbreviations are
     * ISO codes; India Post gives the state's name and nothing else, and its
     * spelling of a state is not always ours ("New Delhi" for DL), so an
     * unmatched name is dropped rather than guessed at.
     */
    const regions = regionsFor(country);
    const match = regions.find(
      (region) =>
        region.code.toUpperCase() === (found.regionCode ?? '').toUpperCase() ||
        region.name.toLowerCase() === (found.region ?? '').toLowerCase()
    );

    return {
      ...(found.city ? { city: found.city } : {}),
      ...(match
        ? { region: match.name, regionCode: match.code }
        : found.region
          ? { region: found.region }
          : {}),
    };
  } catch {
    // A timeout, a 404, malformed JSON, no egress — all the same answer here.
    return null;
  }
}

async function lookupIndiaPost(pincode: string): Promise<PostalLookup | null> {
  const response = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, {
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    // Postcodes do not move. A day is generous and still bounded.
    next: { revalidate: 86_400 },
  });
  if (!response.ok) return null;

  const body: unknown = await response.json();
  const first = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
  if (!first || first['Status'] !== 'Success') return null;

  const offices = first['PostOffice'];
  const office = Array.isArray(offices)
    ? (offices[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!office) return null;

  const district = typeof office['District'] === 'string' ? office['District'] : undefined;
  const state = typeof office['State'] === 'string' ? office['State'] : undefined;

  return {
    ...(district ? { city: district } : {}),
    ...(state ? { region: state } : {}),
  };
}

async function lookupZippopotam(country: string, postalCode: string): Promise<PostalLookup | null> {
  /*
   * Zippopotam holds GB by OUTWARD code only — `EC1A`, never `EC1A 1BB`. Send
   * the full postcode and every British clinic gets a 404.
   */
  const query = country === 'GB' ? (postalCode.split(' ')[0] ?? postalCode) : postalCode;

  const response = await fetch(
    `https://api.zippopotam.us/${country.toLowerCase()}/${encodeURIComponent(query)}`,
    {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      next: { revalidate: 86_400 },
    }
  );
  if (!response.ok) return null;

  const body = (await response.json()) as { places?: Record<string, unknown>[] };
  const place = body.places?.[0];
  if (!place) return null;

  const city = typeof place['place name'] === 'string' ? place['place name'] : undefined;
  const region = typeof place['state'] === 'string' ? place['state'] : undefined;
  const regionCode =
    typeof place['state abbreviation'] === 'string' ? place['state abbreviation'] : undefined;

  return {
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...(regionCode ? { regionCode } : {}),
  };
}
