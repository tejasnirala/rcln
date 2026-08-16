'use server';

import { revalidatePath } from 'next/cache';
import type { VisualMapDetail } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/**
 * Server Actions for the charts a consultation draws on (CE-6).
 *
 * NO PHI ANYWHERE IN THIS FILE. A chart names no patient — the 32 teeth of the
 * FDI notation are the same 32 teeth everywhere — which is why these revalidate
 * freely and why nothing here is read-audited. Contrast `consultation-actions.ts`
 * next door, where the same three verbs deliberately do NOT revalidate: those
 * fire while a doctor is typing, and these end an interaction.
 *
 * ⚠️ THE API'S MESSAGE IS SURFACED VERBATIM AND NEVER REPLACED WITH A FRIENDLIER
 *   ONE. When geometry is rejected, the server says which region and which key —
 *   "Region TOOTH_36's shape does not give a number for "width"". Swapping that
 *   for "Something went wrong" throws away the only thing that lets somebody fix
 *   the document.
 */

export interface ChartFormState {
  error?: string;
  ok?: boolean;
}

export async function createChart(
  slug: string,
  _prev: ChartFormState,
  formData: FormData
): Promise<ChartFormState> {
  const specialtyId = String(formData.get('specialtyId') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();

  const result = await api<VisualMapDetail>('/api/v1/visual-maps', {
    slug,
    accessToken: await getAccessToken(),
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
      viewBox: String(formData.get('viewBox') ?? '').trim(),
      ...(specialtyId !== '' ? { specialtyId } : {}),
      ...(description !== '' ? { description } : {}),
    },
  });

  if (!result.ok) return { error: result.message ?? 'That chart could not be created.' };

  revalidatePath(`/t/${slug}/visual-maps`);
  return { ok: true };
}

export async function updateChart(
  slug: string,
  mapId: string,
  _prev: ChartFormState,
  formData: FormData
): Promise<ChartFormState> {
  const result = await api(`/api/v1/visual-maps/${mapId}`, {
    slug,
    accessToken: await getAccessToken(),
    method: 'PATCH',
    body: {
      name: String(formData.get('name') ?? '').trim(),
      viewBox: String(formData.get('viewBox') ?? '').trim(),
      isActive: formData.get('isActive') === 'on',
    },
  });
  if (!result.ok) return { error: result.message ?? 'That chart could not be saved.' };

  revalidatePath(`/t/${slug}/visual-maps/${mapId}`);
  return { ok: true };
}

/**
 * Add a place to a chart.
 *
 * ⚠️ THE GEOMETRY IS PARSED HERE ONLY TO CATCH A TYPO BEFORE THE ROUND TRIP, NOT
 *   TO VALIDATE IT. Whether the document MEANS anything is `@rcln/clinical`'s to
 *   say, on the server, and this action never second-guesses it — a
 *   browser-side grammar would be a second answer that drifts.
 */
export async function addRegion(
  slug: string,
  mapId: string,
  _prev: ChartFormState,
  formData: FormData
): Promise<ChartFormState> {
  const raw = String(formData.get('metadata') ?? '').trim();
  const parentId = String(formData.get('parentId') ?? '').trim();

  let metadata: unknown;
  if (raw !== '') {
    try {
      metadata = JSON.parse(raw);
    } catch {
      return { error: 'That is not valid JSON. Check for a missing comma or bracket.' };
    }
  }

  const result = await api(`/api/v1/visual-maps/${mapId}/regions`, {
    slug,
    accessToken: await getAccessToken(),
    method: 'POST',
    body: {
      code: String(formData.get('code') ?? '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_'),
      label: String(formData.get('label') ?? '').trim(),
      ...(parentId !== '' ? { parentId } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    },
  });
  if (!result.ok) return { error: result.message ?? 'That region could not be added.' };

  revalidatePath(`/t/${slug}/visual-maps/${mapId}`);
  return { ok: true };
}

export async function removeRegion(
  slug: string,
  mapId: string,
  regionId: string
): Promise<ChartFormState> {
  const result = await api(`/api/v1/visual-maps/${mapId}/regions/${regionId}`, {
    slug,
    accessToken: await getAccessToken(),
    method: 'DELETE',
  });
  if (!result.ok) return { error: result.message ?? 'That region could not be removed.' };

  revalidatePath(`/t/${slug}/visual-maps/${mapId}`);
  return { ok: true };
}
