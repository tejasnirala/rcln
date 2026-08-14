'use server';

import { revalidatePath } from 'next/cache';
import type { ClinicalMasterItem } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/**
 * Server Actions for the clinical vocabulary.
 *
 * NO PHI ANYWHERE IN THIS FILE — a dictionary entry names nobody, which is why
 * these revalidate freely and why nothing here is read-audited. Contrast the
 * episode surface, where every read of one record writes a `data_access_logs`
 * row.
 */

export interface TermFormState {
  error?: string;
  ok?: boolean;
}

export async function createTerm(
  slug: string,
  kind: string,
  _prev: TermFormState,
  formData: FormData
): Promise<TermFormState> {
  const accessToken = await getAccessToken();

  const rawSpecialty = String(formData.get('specialtyId') ?? '').trim();
  const rawIcd = String(formData.get('icd10') ?? '').trim();

  const result = await api<ClinicalMasterItem>('/api/v1/clinical-data', {
    slug,
    accessToken,
    method: 'POST',
    body: {
      kind,
      /* Uppercased here rather than refused: the contract's regex is
         `[A-Z0-9_]+`, and making a clinician retype a lowercase code they have
         already typed once is friction with no safety value. */
      code: String(formData.get('code') ?? '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_'),
      name: String(formData.get('name') ?? '').trim(),
      ...(rawSpecialty !== '' ? { specialtyIds: [rawSpecialty] } : {}),
      /* ⚠️ A CODING IS ONLY EVER WHAT SOMEBODY TYPED. Nothing in this codebase
         infers or suggests an ICD-10 code — a plausible wrong code on a
         diagnosis is a patient-safety defect that reads as perfectly ordinary. */
      ...(rawIcd !== '' ? { codings: [{ system: 'ICD10', code: rawIcd, isPrimary: true }] } : {}),
    },
  });

  if (!result.ok) return { error: result.message ?? 'That term could not be added.' };

  revalidatePath(`/t/${slug}/clinical-terms`);
  return { ok: true };
}

export async function deactivateTerm(slug: string, itemId: string): Promise<TermFormState> {
  const accessToken = await getAccessToken();
  const result = await api(`/api/v1/clinical-data/${itemId}`, {
    slug,
    accessToken,
    method: 'DELETE',
  });
  if (!result.ok) return { error: result.message ?? 'That term could not be withdrawn.' };
  revalidatePath(`/t/${slug}/clinical-terms`);
  return { ok: true };
}
