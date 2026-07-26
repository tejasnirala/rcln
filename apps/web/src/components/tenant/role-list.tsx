'use client';

import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RoleDetail, RoleListResponse } from '@rcln/contracts';
import { Field, inputClass } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { moduleLabel, moduleOf } from '@/lib/permission-labels';
import {
  createRole,
  removeRole,
  saveRole,
  type RoleFormState,
} from '@/app/(tenant)/t/[slug]/(app)/roles/actions';

const IDLE: RoleFormState = { status: 'idle' };

type PermissionCatalogue = RoleListResponse['permissions'];
type CataloguePermission = PermissionCatalogue[number];

function groupByModule(permissions: PermissionCatalogue): [string, CataloguePermission[]][] {
  const groups = new Map<string, CataloguePermission[]>();
  for (const permission of permissions) {
    const bucket = groups.get(permission.module);
    if (bucket) bucket.push(permission);
    else groups.set(permission.module, [permission]);
  }
  return [...groups];
}

/**
 * The module strip — the one thing this screen is built around.
 *
 * A role IS what it grants, and that is normally the thing hidden behind an edit
 * button while the list shows names and dates. So the grant is on the row,
 * always, counted per module: "patients 5 · appointments 6 · billing 3" answers
 * "what is this role for" at a glance, and two roles can be compared without
 * opening either.
 *
 * Modules are a real taxonomy — every permission code is `module.resource.action`
 * — so grouping by them carries information rather than decorating the row. Same
 * reasoning as the week strip on the branches screen, which is where this
 * pattern comes from.
 */
function ModuleStrip({ role }: { role: RoleDetail }) {
  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const code of role.permissionCodes) {
      // Not `module`: Next forbids that identifier, because assigning to it
      // breaks the CommonJS interop shim it compiles through.
      const group = moduleOf(code);
      tally.set(group, (tally.get(group) ?? 0) + 1);
    }
    return [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [role.permissionCodes]);

  if (counts.length === 0) {
    return <p className="text-muted mt-3 text-[0.8125rem]">This role grants nothing yet.</p>;
  }

  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {counts.map(([module, count]) => (
        <li key={module} className="text-[0.8125rem]">
          <span className="text-muted">{moduleLabel(module)}</span>{' '}
          <span className="text-ink font-mono">{count}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The permission grid, grouped by the same modules the strip counts.
 *
 * A code the caller does not hold is shown and disabled rather than hidden: the
 * API refuses to let anyone grant a permission they lack, and quietly dropping
 * those boxes would make the list look complete when it is not.
 */
function PermissionPicker({
  permissions,
  grantable,
  selected,
}: {
  permissions: PermissionCatalogue;
  grantable: Set<string>;
  selected: Set<string>;
}) {
  const groups = useMemo(() => groupByModule(permissions), [permissions]);
  const withheld = permissions.length - grantable.size;

  return (
    <div className="mt-5">
      {withheld > 0 ? (
        <p className="text-muted text-[0.8125rem] leading-relaxed">
          {withheld} permission{withheld === 1 ? ' is' : 's are'} greyed out because you do not hold{' '}
          {withheld === 1 ? 'it' : 'them'} yourself. Nobody can hand on more access than they have.
        </p>
      ) : null}

      <div className="mt-3 grid gap-5 sm:grid-cols-2">
        {groups.map(([module, codes]) => (
          <fieldset key={module}>
            <legend className="eyebrow text-drape">{moduleLabel(module)}</legend>
            <div className="mt-2 grid gap-1">
              {codes.map((permission) => {
                const allowed = grantable.has(permission.code);
                return (
                  <label
                    key={permission.code}
                    className="flex items-start gap-2 py-1 text-[0.8125rem]"
                  >
                    <input
                      type="checkbox"
                      name="permissionCodes"
                      value={permission.code}
                      defaultChecked={selected.has(permission.code)}
                      disabled={!allowed}
                      className="accent-drape mt-0.5 h-4 w-4"
                    />
                    <span className={allowed ? 'text-ink' : 'text-muted'}>
                      {permission.description ?? permission.code}
                      {/* Never colour or dimming alone (WCAG 1.4.1). */}
                      {allowed ? null : <span className="sr-only"> (you cannot grant this)</span>}
                      <code className="text-muted ml-1.5 text-[0.6875rem]">{permission.code}</code>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}

interface Draft {
  code: string;
  name: string;
  description: string;
  scopeLevel: 'ORGANIZATION' | 'BRANCH';
  permissionCodes: string[];
}

const EMPTY_DRAFT: Draft = {
  code: '',
  name: '',
  description: '',
  scopeLevel: 'BRANCH',
  permissionCodes: [],
};

/**
 * What a clinic's staff may do.
 *
 * The screen answers one question — what does each role actually grant — so the
 * grant is the row and the name is the label on it. Built-in roles sit in the
 * same list as the clinic's own, because they are assigned the same way; they
 * are marked, not separated, and the only thing they cannot do is change.
 *
 * Duplicating one is how a clinic gets "Doctor, but without prescription
 * signing". There is no duplicate endpoint and does not need to be: the list
 * already carries every role's permission codes, so this opens the create form
 * with them ticked.
 */
export function RoleList({
  slug,
  roles,
  permissions,
  grantableCodes,
}: {
  slug: string;
  roles: RoleDetail[];
  permissions: PermissionCatalogue;
  grantableCodes: string[];
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const closeDraft = useCallback(() => setDraft(null), []);
  const grantable = useMemo(() => new Set(grantableCodes), [grantableCodes]);

  const custom = roles.filter((role) => !role.isSystem);
  const builtIn = roles.filter((role) => role.isSystem);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow text-drape">Access</p>
          <h1 className="font-display mt-2 text-3xl tracking-tight">Roles</h1>
          <p className="text-muted mt-2 max-w-xl text-[0.9375rem] leading-relaxed">
            A role is a set of permissions you give someone. Built-in roles are shared with every
            clinic on rcln and cannot be changed — duplicate one to make it yours.
          </p>
        </div>
        <Button
          onClick={() => setDraft((open) => (open ? null : EMPTY_DRAFT))}
          aria-expanded={draft !== null}
        >
          {draft ? 'Cancel' : 'Create a role'}
        </Button>
      </div>

      {draft ? (
        <div className="border-drape bg-drape-tint/40 mt-6 rounded-lg border p-5">
          <CreateForm
            slug={slug}
            draft={draft}
            permissions={permissions}
            grantable={grantable}
            onDone={closeDraft}
          />
        </div>
      ) : null}

      <section className="mt-8" aria-labelledby="custom-heading">
        <h2 id="custom-heading" className="eyebrow text-muted">
          This clinic&rsquo;s roles
        </h2>
        {custom.length === 0 ? (
          <p className="text-muted mt-3 text-[0.875rem]">
            None yet. Duplicate a built-in role below to start from something that works.
          </p>
        ) : (
          <ul className="mt-3 grid gap-4">
            {custom.map((role) => (
              <RoleCard
                key={role.id}
                slug={slug}
                role={role}
                permissions={permissions}
                grantable={grantable}
                onDuplicate={setDraft}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="border-rule mt-10 border-t pt-8" aria-labelledby="builtin-heading">
        <h2 id="builtin-heading" className="eyebrow text-muted">
          Built in
        </h2>
        <ul className="mt-3 grid gap-4">
          {builtIn.map((role) => (
            <RoleCard
              key={role.id}
              slug={slug}
              role={role}
              permissions={permissions}
              grantable={grantable}
              onDuplicate={setDraft}
            />
          ))}
        </ul>
      </section>
    </>
  );
}

function RoleCard({
  slug,
  role,
  permissions,
  grantable,
  onDuplicate,
}: {
  slug: string;
  role: RoleDetail;
  permissions: PermissionCatalogue;
  grantable: Set<string>;
  onDuplicate: (draft: Draft) => void;
}) {
  const [editing, setEditing] = useState(false);
  const closeEdit = useCallback(() => setEditing(false), []);

  return (
    <li className="border-rule bg-card rounded-lg border p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ink text-[0.9375rem] font-medium">{role.name}</h3>
            {/* A role code is an identifier, so it is set in mono like one. */}
            <code className="text-muted text-[0.75rem]">{role.code}</code>
            {role.isSystem ? (
              <span className="bg-drape-tint text-drape-deep rounded-xs px-2 py-0.5 text-[0.6875rem] font-medium">
                Built in
              </span>
            ) : null}
          </div>
          {role.description ? (
            <p className="text-muted mt-1 max-w-2xl text-[0.8125rem] leading-relaxed">
              {role.description}
            </p>
          ) : null}
          <p className="text-muted mt-1 text-[0.8125rem]">
            {role.scopeLevel === 'ORGANIZATION' ? 'Covers the whole clinic' : 'Given per branch'}
            {' · '}
            {role.memberCount === 0
              ? 'nobody holds it'
              : `held by ${String(role.memberCount)} ${role.memberCount === 1 ? 'person' : 'people'}`}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              onDuplicate({
                code: '',
                name: `${role.name} (copy)`,
                description: role.description ?? '',
                scopeLevel: role.scopeLevel,
                permissionCodes: role.permissionCodes,
              })
            }
          >
            Duplicate
          </Button>
          {role.isSystem ? null : (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setEditing((open) => !open)}
                aria-expanded={editing}
              >
                {editing ? 'Close' : 'Edit'}
              </Button>
              <RemoveButton slug={slug} role={role} />
            </>
          )}
        </div>
      </div>

      <ModuleStrip role={role} />

      {editing ? (
        <div className="border-rule mt-5 border-t pt-5">
          <EditForm
            slug={slug}
            role={role}
            permissions={permissions}
            grantable={grantable}
            onDone={closeEdit}
          />
        </div>
      ) : null}
    </li>
  );
}

function RemoveButton({ slug, role }: { slug: string; role: RoleDetail }) {
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState(removeRole.bind(null, slug, role.id), IDLE);

  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" className="text-signal" onClick={() => setConfirming(true)}>
        Remove
      </Button>
    );
  }

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="danger" type="submit" disabled={pending}>
        {pending ? 'Removing…' : 'Remove it'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Keep it
      </Button>
      {state.status === 'error' ? (
        <Alert tone="error" className="w-full basis-full">
          {state.message}
        </Alert>
      ) : null}
    </form>
  );
}

function CreateForm({
  slug,
  draft,
  permissions,
  grantable,
  onDone,
}: {
  slug: string;
  draft: Draft;
  permissions: PermissionCatalogue;
  grantable: Set<string>;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState(createRole.bind(null, slug), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  // Collapse once saved. In an effect, not in render: calling a parent's
  // setState during render produces the "Cannot update a component while
  // rendering a different component" warning.
  useEffect(() => {
    if (state.status === 'saved') onDone();
  }, [state.status, onDone]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];
  const selected = useMemo(() => new Set(draft.permissionCodes), [draft.permissionCodes]);

  return (
    <form ref={formRef} action={action} noValidate>
      <h2 className="text-ink text-[0.9375rem] font-medium">Create a role</h2>
      <p className="text-muted mt-1 text-[0.8125rem] leading-relaxed">
        The code is how the system refers to this role. It cannot be changed later, and it cannot
        match a built-in one.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field name="name" label="Name" errors={err('name')}>
          <input
            id="name"
            name="name"
            className={inputClass}
            defaultValue={draft.name}
            required
            autoComplete="off"
          />
        </Field>
        <Field name="code" label="Code" hint="UPPER_SNAKE_CASE" errors={err('code')}>
          <input
            id="code"
            name="code"
            className={`${inputClass} font-mono`}
            defaultValue={draft.code}
            required
            autoComplete="off"
          />
        </Field>
        <Field name="description" label="Description" errors={err('description')}>
          <input
            id="description"
            name="description"
            className={inputClass}
            defaultValue={draft.description}
            autoComplete="off"
          />
        </Field>
        <Field
          name="scopeLevel"
          label="Where it applies"
          hint="Per branch, or across the whole clinic"
          errors={err('scopeLevel')}
        >
          <select
            id="scopeLevel"
            name="scopeLevel"
            className={inputClass}
            defaultValue={draft.scopeLevel}
          >
            <option value="BRANCH">One branch at a time</option>
            <option value="ORGANIZATION">The whole clinic</option>
          </select>
        </Field>
      </div>

      <PermissionPicker permissions={permissions} grantable={grantable} selected={selected} />

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-5">
          {state.message}
        </Alert>
      ) : null}

      <div className="mt-5 flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create role'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EditForm({
  slug,
  role,
  permissions,
  grantable,
  onDone,
}: {
  slug: string;
  role: RoleDetail;
  permissions: PermissionCatalogue;
  grantable: Set<string>;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState(saveRole.bind(null, slug, role.id), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  useEffect(() => {
    if (state.status === 'saved') onDone();
  }, [state.status, onDone]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];
  const selected = useMemo(() => new Set(role.permissionCodes), [role.permissionCodes]);

  return (
    <form ref={formRef} action={action} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name={`name-${role.id}`} label="Name" errors={err('name')}>
          <input
            id={`name-${role.id}`}
            name="name"
            className={inputClass}
            defaultValue={role.name}
            required
            autoComplete="off"
          />
        </Field>
        <Field name={`description-${role.id}`} label="Description" errors={err('description')}>
          <input
            id={`description-${role.id}`}
            name="description"
            className={inputClass}
            defaultValue={role.description ?? ''}
            autoComplete="off"
          />
        </Field>
      </div>

      <p className="text-muted mt-4 text-[0.8125rem] leading-relaxed">
        Everything ticked here is what the role grants when you save. Unticking a box takes that
        permission away from everyone who holds this role.
      </p>

      <PermissionPicker permissions={permissions} grantable={grantable} selected={selected} />

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-5">
          {state.message}
        </Alert>
      ) : null}

      <div className="mt-5 flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save role'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
