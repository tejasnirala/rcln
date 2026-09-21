/**
 * How a patient's sex and age are worded, in one place.
 *
 * ⚠️ SHARED BECAUSE TWO SCREENS NOW STATE THE SAME FACT. The patients screen and
 *   the booking panel both have to say "34 · Female" against a name, and two
 *   copies of that mapping is how one screen ends up saying "Not recorded" while
 *   the other says "Unknown" about the same record. The vocabulary the API uses
 *   is `genderValues` in `@rcln/contracts`; this is what it reads as on screen.
 *
 * The list deliberately offers "Not recorded" rather than omitting `UNKNOWN`: a
 * front desk that does not know must be able to say so, and a required field
 * with no honest answer gets a wrong one picked instead.
 */

import type { SelectOption } from '@/components/ui/field';

export const GENDERS: SelectOption[] = [
  { value: 'FEMALE', label: 'Female' },
  { value: 'MALE', label: 'Male' },
  { value: 'OTHER', label: 'Other' },
  { value: 'UNKNOWN', label: 'Not recorded' },
];

export const GENDER_WORDS: Record<string, string> = {
  FEMALE: 'Female',
  MALE: 'Male',
  OTHER: 'Other',
  UNKNOWN: 'Sex not recorded',
};

/** "34 · Female", or "approx. 60 · Male" when the age was estimated. */
export function ageLine(patient: {
  age: number | null;
  ageIsApproximate: boolean;
  gender: string;
}): string {
  const sex = GENDER_WORDS[patient.gender] ?? 'Sex not recorded';
  if (patient.age === null) return sex;
  return `${patient.ageIsApproximate ? 'approx. ' : ''}${String(patient.age)} · ${sex}`;
}

/**
 * Blood groups, in the order a desk reads them off a card — "not known" first,
 * because it is both the default and the honest answer most of the time.
 *
 * ⚠️ HUMAN GROUPS. `bloodGroupValues` is ABO/Rh, which is a human taxonomy; an
 *   animal record does not offer this field at all rather than inviting a
 *   choice between eight wrong answers. See `IdentityStrip` in
 *   `patient-chart.tsx`, which hides the line for the same reason.
 */
export const BLOOD_GROUPS: SelectOption[] = [
  { value: 'UNKNOWN', label: 'Not known' },
  { value: 'O_POSITIVE', label: 'O positive' },
  { value: 'O_NEGATIVE', label: 'O negative' },
  { value: 'A_POSITIVE', label: 'A positive' },
  { value: 'A_NEGATIVE', label: 'A negative' },
  { value: 'B_POSITIVE', label: 'B positive' },
  { value: 'B_NEGATIVE', label: 'B negative' },
  { value: 'AB_POSITIVE', label: 'AB positive' },
  { value: 'AB_NEGATIVE', label: 'AB negative' },
];

/** `maritalStatusValues`, worded for a form. Not asked of an animal. */
export const MARITAL_STATUSES: SelectOption[] = [
  { value: 'UNKNOWN', label: 'Not recorded' },
  { value: 'SINGLE', label: 'Single' },
  { value: 'MARRIED', label: 'Married' },
  { value: 'WIDOWED', label: 'Widowed' },
  { value: 'DIVORCED', label: 'Divorced' },
  { value: 'SEPARATED', label: 'Separated' },
];
