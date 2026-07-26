'use server';

import { revalidatePath } from 'next/cache';
import { createRoleRequest, updateRoleRequest, type RoleDetail } from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * Creating and editing the clinic's own roles.
 *
 * `slug` is threaded through every action and turned into the Host header by
 * api(). Without it the server-to-server fetch arrives as `api:5000`, resolves
 * to no tenant, and every call 404s.
 *
 * These actions are bound to the slug on the server before they reach the
 * browser, so a client cannot re-point one at another clinic.
 *
 * NOTE: a 'use server' module may export async functions and nothing else — not
 * a constant, not an object. Types are erased at compile time so `export type`
 * is fine; the shared `idle` state lives with the component that renders it.
 */

export type RoleFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

export async function createRole(
  slug: string,
  _previous: RoleFormState,
  formData: FormData
): Promise<RoleFormState> {
  const parsed = createRoleRequest.safeParse({
    code: String(formData.get('code') ?? '')
      .trim()
      .toUpperCase(),
    name: String(formData.get('name') ?? '').trim(),
    description: String(formData.get('description') ?? '').trim() || undefined,
    scopeLevel: String(formData.get('scopeLevel') ?? 'BRANCH'),
    permissionCodes: formData.getAll('permissionCodes').map(String),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<RoleDetail>('/api/v1/roles', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      // The API refuses a reserved code, a duplicate, and any permission the
      // caller does not hold themselves. Its message says which.
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/roles`);
  return { status: 'saved', message: `${parsed.data.name} is ready to assign.` };
}

/**
 * The permission set is replaced wholesale, not merged.
 *
 * Every checkbox is submitted every time, so an unticked box is a permission the
 * role stops granting. That is the contract's shape too — same as a branch's
 * operating hours.
 */
export async function saveRole(
  slug: string,
  roleId: string,
  _previous: RoleFormState,
  formData: FormData
): Promise<RoleFormState> {
  const parsed = updateRoleRequest.safeParse({
    name: String(formData.get('name') ?? '').trim(),
    description: String(formData.get('description') ?? '').trim() || null,
    permissionCodes: formData.getAll('permissionCodes').map(String),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'A role needs a name and at least one permission.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<RoleDetail>(`/api/v1/roles/${roleId}`, {
    method: 'PATCH',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/roles`);
  return { status: 'saved', message: 'Role updated.' };
}

export async function removeRole(
  slug: string,
  roleId: string,
  _previous: RoleFormState
): Promise<RoleFormState> {
  const result = await api(`/api/v1/roles/${roleId}`, {
    method: 'DELETE',
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok) {
    return {
      status: 'error',
      // Refused while anyone still holds it — deleting would strip it from them.
      ...(result.message !== undefined ? { message: result.message } : {}),
    };
  }

  revalidatePath(`/t/${slug}/roles`);
  return { status: 'saved', message: 'Role removed.' };
}
