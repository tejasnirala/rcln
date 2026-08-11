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
