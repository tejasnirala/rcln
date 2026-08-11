'use server';

import { revalidatePath } from 'next/cache';
import {
  createClinicTaxRegistrationRequest,
  createClinicTaxRuleRequest,
  setClinicTaxRegistrationBranchesRequest,
  type ClinicTaxRegistrationSummary,
  type ClinicTaxRuleSummary,
  type TaxRateCardResponse,
} from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The clinic's rate card.
 *
 * ⚠️ NOTHING HERE IS A SETTING, AND THE COPY ON THE SCREEN HAS TO CARRY THAT. A
 *   slot length is a preference; a tax rule decides what every patient is charged
 *   and what the clinic owes the government. An exempt consultation rated at 18%
 *   collects money nobody owed, and a 12% medicine rated at 0% leaves the clinic
 *   owing tax it never took. Hence `billing.tax.manage` rather than a settings
 *   code, and hence a screen that states the consequence of every control.
 *
 * ⚠️ AND A RATE CHANGE IS A NEW ROW, NEVER AN EDIT. Both ends of the effective
 *   dates are inclusive: a rate ending is an end date on the old rule and a new
 *   rule from the day after. The API refuses an edit that would move the rate on
 *   a rule an issued invoice was priced under, because that invoice's totals are
 *   frozen and the rule is the account of what it charged.
 */

export type TaxFormState = {
  status: 'idle' | 'error' | 'done';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * What this clinic charges, inherited rows and overrides together.
 *
 * ⚠️ THE CARD AND NOT `GET /tax/rules`, BECAUSE A CLINIC WITH NO RULES OF ITS OWN
 *   IS FULLY CONFIGURED. rcln maintains a catalogue per country and the engine
 *   READS it at pricing time rather than copying it at signup, so a screen built
 *   on the clinic's own rows would show an empty page to a clinic that is charging
 *   tax on every bill it issues.
 */
export async function loadRateCard(slug: string): Promise<TaxRateCardResponse | null> {
  const result = await api<TaxRateCardResponse>('/api/v1/tax/rate-card', {
    slug,
    accessToken: await getAccessToken(),
  });
  return result.ok && result.data ? result.data : null;
}

/** Every rule this clinic wrote, lapsed ones included when asked for. */
export async function loadRules(
  slug: string,
  includeExpired: boolean
): Promise<ClinicTaxRuleSummary[]> {
  const result = await api<{ rules: ClinicTaxRuleSummary[] }>(
    `/api/v1/tax/rules?includeExpired=${includeExpired ? 'true' : 'false'}`,
    { slug, accessToken: await getAccessToken() }
  );
  return result.ok && result.data ? result.data.rules : [];
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Record a registration this clinic holds.
 *
 * ⚠️ FROM THE MOMENT IT TAKES EFFECT, EVERY INVOICE IT COVERS CARRIES TAX. There
 *   is no publish step — the engine reads the live registrations on every pricing
 *   pass — which is the point, and also why `effectiveFrom` is asked for rather
 *   than assumed to be today.
 */
export async function addRegistration(
  slug: string,
  input: {
    countryCode: string;
    regionCode?: string;
    scheme: string;
    registrationNumber: string;
    legalName?: string;
    effectiveFrom: string;
  }
): Promise<TaxFormState> {
  const parsed = createClinicTaxRegistrationRequest.safeParse(input);

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<ClinicTaxRegistrationSummary>('/api/v1/tax/registrations', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      /*
       * The API's own sentence. A 409 here is this clinic having already recorded
       * that exact number, and saying so is more use than anything this layer
       * could invent — a second registration in the same state is legitimate, the
       * same registration twice is not.
       */
      message: result.message ?? 'The registration could not be recorded.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/taxes`);
  return { status: 'done' };
}

/**
 * Lapse a registration on the day it stopped being in force.
 *
 * ⚠️ NOT A DELETE, AND THERE IS DELIBERATELY NO DELETE TO REACH FOR. The row is
 *   the account of every invoice issued under it: a bill raised next April for a
 *   consultation given last March has to cite the number in force in March, and
 *   `loadTaxContext` finds it by date. Removing the row would leave those
 *   documents unexplainable.
 *
 * ⚠️ AND IT IS WHAT MAKES A SUCCESSOR RECORDABLE. Ending this one and adding the
 *   replacement from the day after is the whole succession flow — the two rows
 *   sit side by side in one jurisdiction, one ended and one in force.
 *
 * The date is inclusive: the registration applied on the day given.
 */
export async function endRegistration(
  slug: string,
  registrationId: string,
  effectiveTo: string
): Promise<TaxFormState> {
  const result = await api<ClinicTaxRegistrationSummary>(
    `/api/v1/tax/registrations/${registrationId}`,
    {
      method: 'PATCH',
      slug,
      accessToken: await getAccessToken(),
      body: { effectiveTo },
    }
  );

  if (!result.ok) {
    return {
      status: 'error',
      // A 400 here is an end date before the registration began, which the
      // database refuses outright — a range that runs backwards matches nothing,
      // silently, forever.
      message: result.message ?? 'The registration could not be ended.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/taxes`);
  return { status: 'done' };
}

/**
 * State which branches a registration covers.
 *
 * ⚠️ THE WHOLE SET, EVERY TIME. A branch left out of `branchIds` stops being
 *   covered — the same replace-not-patch shape as opening hours, and the only
 *   form in which coverage can be removed. Sending an empty list is legitimate
 *   and returns the registration to matching branches by jurisdiction.
 */
export async function setRegistrationBranches(
  slug: string,
  registrationId: string,
  branchIds: string[]
): Promise<TaxFormState> {
  const parsed = setClinicTaxRegistrationBranchesRequest.safeParse({ branchIds });

  if (!parsed.success) {
    return { status: 'error', message: 'That list of branches could not be saved.' };
  }

  const result = await api<ClinicTaxRegistrationSummary>(
    `/api/v1/tax/registrations/${registrationId}/branches`,
    {
      method: 'PUT',
      slug,
      accessToken: await getAccessToken(),
      body: parsed.data,
    }
  );

  if (!result.ok) {
    return {
      status: 'error',
      /*
       * A 409 here names the registration already covering that branch for an
       * overlapping period. Two live registrations of one scheme on one branch is
       * an invoice whose number depends on planner order, so the API refuses it
       * and this passes the sentence through.
       */
      message: result.message ?? 'Coverage could not be saved.',
    };
  }

  revalidatePath(`/t/${slug}/taxes`);
  return { status: 'done' };
}

/**
 * Override the catalogue for one category.
 *
 * ⚠️ ALL-OR-NOTHING PER CATEGORY, AND THE SCREEN SAYS SO BEFORE THIS IS CALLED.
 *   One rule for a category takes the WHOLE category out of the inherited set —
 *   rcln's rows for it stop applying entirely. A clinic that overrode one half of
 *   a stacked pair and kept inheriting the other would be issuing invoices
 *   carrying one rate it chose and one it has never seen.
 */
export async function addRule(
  slug: string,
  input: {
    countryCode: string;
    regionCode?: string;
    scheme: string;
    taxCategory: string;
    description?: string;
    rateBps: number;
    treatment: string;
    lineName: string;
    regionalLineName?: string;
    split: string;
    stacks: boolean;
    effectiveFrom: string;
  }
): Promise<TaxFormState> {
  const parsed = createClinicTaxRuleRequest.safeParse(input);

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<ClinicTaxRuleSummary>('/api/v1/tax/rules', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      message: result.message ?? 'The rate could not be added.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/taxes`);
  return { status: 'done' };
}

/**
 * Stop charging a rule from a date.
 *
 * ⚠️ NOT A DELETE, AND THE INTERFACE MUST NOT LET IT LOOK LIKE ONE. The row
 *   survives, because an invoice issued last March has to stay explicable and the
 *   row that priced it is the explanation. What applies afterwards depends on the
 *   category: rcln's default comes back where the catalogue covers it, and the
 *   category goes unrated — unissuable — where it does not.
 */
export async function endRule(
  slug: string,
  ruleId: string,
  effectiveTo: string
): Promise<TaxFormState> {
  const result = await api<ClinicTaxRuleSummary>(`/api/v1/tax/rules/${ruleId}/end`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: { effectiveTo },
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The rate could not be ended.' };
  }

  revalidatePath(`/t/${slug}/taxes`);
  return { status: 'done' };
}
