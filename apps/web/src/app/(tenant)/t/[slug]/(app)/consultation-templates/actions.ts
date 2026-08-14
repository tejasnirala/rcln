'use server';

import { revalidatePath } from 'next/cache';
import type { ConsultationTemplateDetail } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/**
 * Server Actions for the consultation configuration.
 *
 * NO PHI ANYWHERE IN THIS FILE. A template names no patient, which is why these
 * revalidate freely and why nothing here is read-audited. Contrast the episode
 * surface, where every read of one record writes a `data_access_logs` row.
 *
 * ⚠️ THE API'S MESSAGE IS SURFACED VERBATIM AND NEVER REPLACED WITH A FRIENDLIER
 *   ONE. When a definition is rejected, the server says which section and which
 *   key — "section 3 does not say \"visible\"…". Swapping that for "Something
 *   went wrong" throws away the only thing that lets somebody fix a document.
 */

export interface TemplateFormState {
  error?: string;
  ok?: boolean;
}

export async function createTemplate(
  slug: string,
  _prev: TemplateFormState,
  formData: FormData
): Promise<TemplateFormState> {
  const accessToken = await getAccessToken();
  const specialtyId = String(formData.get('specialtyId') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();

  const result = await api<ConsultationTemplateDetail>('/api/v1/consultation-templates', {
    slug,
    accessToken,
    method: 'POST',
    body: {
      /* Uppercased here rather than refused: the contract's regex is
         `[A-Z][A-Z0-9_]*`, and making somebody retype a code they have already
         typed once is friction with no safety value. */
      code: String(formData.get('code') ?? '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_'),
      name: String(formData.get('name') ?? '').trim(),
      careContextId: String(formData.get('careContextId') ?? '').trim(),
      ...(specialtyId !== '' ? { specialtyId } : {}),
      ...(description !== '' ? { description } : {}),
    },
  });

  if (!result.ok) return { error: result.message ?? 'That template could not be created.' };

  revalidatePath(`/t/${slug}/consultation-templates`);
  return { ok: true };
}

/** Start a new draft, copied from the published version. */
export async function startDraft(slug: string, templateId: string): Promise<TemplateFormState> {
  const accessToken = await getAccessToken();
  const result = await api(`/api/v1/consultation-templates/${templateId}/versions`, {
    slug,
    accessToken,
    method: 'POST',
  });
  if (!result.ok) return { error: result.message ?? 'A draft could not be started.' };
  revalidatePath(`/t/${slug}/consultation-templates/${templateId}`);
  return { ok: true };
}

/**
 * Save the draft's document.
 *
 * ⚠️ THE JSON IS PARSED HERE ONLY TO CATCH A TYPO BEFORE THE ROUND TRIP, NOT TO
 *   VALIDATE THE CONFIGURATION. Whether the document MEANS anything is
 *   `@rcln/clinical`'s to say, on the server, and this action never second-
 *   guesses it — a browser-side grammar would be a second answer that drifts.
 */
export async function saveDraft(
  slug: string,
  templateId: string,
  versionId: string,
  _prev: TemplateFormState,
  formData: FormData
): Promise<TemplateFormState> {
  const raw = String(formData.get('definition') ?? '');

  let definition: unknown;
  try {
    definition = JSON.parse(raw);
  } catch {
    return { error: 'That is not valid JSON. Check for a missing comma or bracket.' };
  }

  const accessToken = await getAccessToken();
  const result = await api(`/api/v1/consultation-templates/${templateId}/versions/${versionId}`, {
    slug,
    accessToken,
    method: 'PUT',
    body: { definition },
  });
  if (!result.ok) return { error: result.message ?? 'That configuration could not be saved.' };

  revalidatePath(`/t/${slug}/consultation-templates/${templateId}`);
  return { ok: true };
}

/** Put the draft live, retiring the version it replaces. */
export async function publishVersion(
  slug: string,
  templateId: string,
  versionId: string
): Promise<TemplateFormState> {
  const accessToken = await getAccessToken();
  const result = await api(
    `/api/v1/consultation-templates/${templateId}/versions/${versionId}/publish`,
    { slug, accessToken, method: 'POST' }
  );
  if (!result.ok) return { error: result.message ?? 'That version could not be published.' };
  revalidatePath(`/t/${slug}/consultation-templates/${templateId}`);
  return { ok: true };
}

export async function discardDraft(
  slug: string,
  templateId: string,
  versionId: string
): Promise<TemplateFormState> {
  const accessToken = await getAccessToken();
  const result = await api(`/api/v1/consultation-templates/${templateId}/versions/${versionId}`, {
    slug,
    accessToken,
    method: 'DELETE',
  });
  if (!result.ok) return { error: result.message ?? 'That draft could not be discarded.' };
  revalidatePath(`/t/${slug}/consultation-templates/${templateId}`);
  return { ok: true };
}

export async function setTemplateActive(
  slug: string,
  templateId: string,
  isActive: boolean
): Promise<TemplateFormState> {
  const accessToken = await getAccessToken();
  const result = await api(`/api/v1/consultation-templates/${templateId}`, {
    slug,
    accessToken,
    method: 'PATCH',
    body: { isActive },
  });
  if (!result.ok) return { error: result.message ?? 'That template could not be updated.' };
  revalidatePath(`/t/${slug}/consultation-templates`);
  revalidatePath(`/t/${slug}/consultation-templates/${templateId}`);
  return { ok: true };
}
