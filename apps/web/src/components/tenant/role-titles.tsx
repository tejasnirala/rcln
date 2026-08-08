'use client';

import { useState } from 'react';
import type { RolePairings } from '@rcln/contracts';
import { Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { saveRolePairings } from '@/app/(tenant)/t/[slug]/(app)/settings/actions';

/**
 * Which job titles fit which role.
 *
 * One role at a time rather than a full grid: twelve roles by thirty-five
 * titles is four hundred checkboxes, which is a wall rather than a screen. The
 * role picker turns it into one readable list of about thirty.
 *
 * Every row says whether it is a platform default, so a clinic can see what it
 * has changed and what it has merely inherited — the same "where did this come
 * from" rule the Defaults section above it follows.
 */
export function RoleTitles({ slug, roles }: { slug: string; roles: RolePairings[] }) {
  const [roleId, setRoleId] = useState(roles[0]?.roleId ?? '');
  const role = roles.find((r) => r.roleId === roleId);

  /*
   * The ticks for the role on screen, held here so the whole list can be edited
   * and saved once. Keyed by role so switching away and back does not lose an
   * unsaved change.
   */
  const [edits, setEdits] = useState<Record<string, Set<string>>>({});
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: 'error' | 'info'; message: string } | null>(null);

  if (!role) return null;

  const checked =
    edits[roleId] ?? new Set(role.titles.filter((t) => t.enabled).map((t) => t.designationId));

  const toggle = (designationId: string): void => {
    const next = new Set(checked);
    if (next.has(designationId)) next.delete(designationId);
    else next.add(designationId);
    setEdits((current) => ({ ...current, [roleId]: next }));
    setOutcome(null);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    const result = await saveRolePairings(slug, roleId, [...checked]);
    setSaving(false);

    if (!result.ok) {
      setOutcome({ tone: 'error', message: result.message });
      return;
    }
    // Drop the local edit so the next render reads the server's answer.
    setEdits((current) => {
      const next = { ...current };
      delete next[roleId];
      return next;
    });
    setOutcome({ tone: 'info', message: `Titles for ${role.roleName} saved.` });
  };

  const dirty = edits[roleId] !== undefined;

  return (
    <div className="mt-4">
      <div className="max-w-xs">
        <Select
          name="roleId"
          label="Role"
          value={roleId}
          onChange={(event) => {
            setRoleId(event.target.value);
            setOutcome(null);
          }}
          options={roles.map((r) => ({ value: r.roleId, label: r.roleName }))}
        />
      </div>

      {outcome ? (
        <Alert tone={outcome.tone} className="mt-4">
          {outcome.message}
        </Alert>
      ) : null}

      <fieldset className="mt-5">
        <legend className="sr-only">Titles that fit {role.roleName}</legend>
        <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          {role.titles.map((title) => (
            <li key={title.designationId}>
              <label className="flex items-center gap-2 py-1.5 text-[0.875rem]">
                <input
                  type="checkbox"
                  className="accent-drape h-4 w-4"
                  checked={checked.has(title.designationId)}
                  onChange={() => toggle(title.designationId)}
                />
                <span className="text-ink">{title.name}</span>
                {title.isPlatformDefault ? (
                  <span className="text-muted text-[0.6875rem]">
                    <span aria-hidden="true">standard</span>
                    <span className="sr-only">a standard title for this role</span>
                  </span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div className="mt-5 flex items-center gap-3">
        <Button
          type="button"
          disabled={saving || !dirty}
          onClick={() => {
            void save();
          }}
        >
          {saving ? 'Saving…' : 'Save titles'}
        </Button>
        {dirty ? <p className="text-muted text-[0.8125rem]">Not saved yet.</p> : null}
      </div>
    </div>
  );
}
