/**
 * Organization — the clinic's own record, and the settings that hang off it.
 *
 * ⚠️ SINGULAR, AND THERE IS NO ID IN ANY PATH. Which clinic this is was decided
 *   by the `Host` header before the handler ran, so there is nothing to select.
 *   An endpoint here that took an `organizationId` would be a way to ask about
 *   somebody else's clinic, which is the whole thing RLS exists to prevent.
 */
import { organizationProfile, settingItem, settingListResponse } from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import { ORG_ID, ORGANIZATION } from './fixtures.js';

const ORGANIZATION_EXAMPLE = {
  id: ORG_ID,
  name: ORGANIZATION.name,
  legalName: ORGANIZATION.legalName,
  slug: ORGANIZATION.slug,
  orgType: 'CLINIC',
  status: ORGANIZATION.status,
  taxId: '29AAACA1234C1ZP',
  countryCode: ORGANIZATION.countryCode,
  regionCode: ORGANIZATION.regionCode,
  currency: ORGANIZATION.currency,
  timezone: ORGANIZATION.timezone,
  phone: '+919845012345',
  email: 'hello@alphaclinic.in',
  website: 'https://alphaclinic.in',
  logoUrl: null,
  branchCount: 2,
};

const KEY_NOTE =
  'The setting key, as `GET /api/v1/organization/settings` lists it — `locale.time_format`, `appointment.default_slot_minutes`. A `VarChar(128)`, not a uuid. A key no definition declares is answered `404`.';

export const organizationDocs: DocRegistry = {
  'GET /api/v1/organization': {
    summary: 'Get the clinic',
    description: `
The clinic's own record: who it is legally, where it is registered, and the
defaults its branches inherit.

\`timezone\`, \`countryCode\`, \`regionCode\` and \`currency\` here are the
**fallbacks a new branch takes when it does not state its own**. Reading a time
or raising an invoice always uses the *branch's* values, never these — which is
why a group can open in a second state without changing anything on this record.
`.trim(),
    response: organizationProfile,
    responseExamples: [
      {
        summary: 'A two-branch clinic',
        value: { success: true, message: 'Success', data: ORGANIZATION_EXAMPLE },
      },
    ],
  },

  'PATCH /api/v1/organization': {
    summary: 'Update the clinic',
    description: `
A partial update of the clinic's own details. Only what you send changes.

**\`slug\` is not editable here, and not anywhere else.** It is the subdomain
every session cookie is scoped to, so changing it would sign out every member
mid-shift and break every bookmark the clinic has. Moving a clinic to a new
subdomain is a support operation, not an API call.

Changing \`countryCode\` or \`regionCode\` changes the default jurisdiction that
*future* branches inherit. It does **not** re-issue existing tax registrations
and does not touch invoices already raised — those recorded the jurisdiction
that applied on the day.

Writes an \`audit_logs\` row with the caller, their IP and their user agent.
`.trim(),
    response: organizationProfile,
    message: 'Clinic details updated',
    errors: [409],
    requestExamples: [
      {
        summary: 'Correct the contact details',
        value: { phone: '+918041234567', email: 'reception@alphaclinic.in' },
      },
      {
        summary: 'Register for tax after the fact',
        description: 'A clinic that signed up without a number and has since received one.',
        value: { taxId: '29AAACA1234C1ZP' },
      },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: {
          success: true,
          message: 'Clinic details updated',
          data: {
            ...ORGANIZATION_EXAMPLE,
            phone: '+918041234567',
            email: 'reception@alphaclinic.in',
          },
        },
      },
    ],
  },

  'GET /api/v1/organization/settings': {
    summary: 'List settings',
    description: `
Every setting this clinic can hold, **as it currently resolves** — not only the
ones it has overridden.

Each item carries the value in force, the platform default it came from, and
whether this clinic has overruled it. That is what lets a settings screen render
the whole surface without a second call to find out what a field would fall back
to if cleared.

Read it alongside \`locale.time_format\`, which is the per-branch 12H/24H
decision every rendered time in the product obeys.
`.trim(),
    response: settingListResponse,
    responseExamples: [
      {
        summary: 'A clinic that has overridden two settings',
        value: {
          success: true,
          message: 'Success',
          data: {
            settings: [
              {
                key: 'locale.time_format',
                label: 'Time format',
                group: 'locale',
                valueType: 'ENUM',
                value: '24H',
                defaultValue: '12H',
                isOverridden: true,
                choices: [
                  { value: '12H', label: '12-hour (9:30 AM)' },
                  { value: '24H', label: '24-hour (09:30)' },
                ],
              },
              {
                key: 'appointment.default_slot_minutes',
                label: 'Default appointment length',
                group: 'appointment',
                valueType: 'NUMBER',
                value: 20,
                defaultValue: 15,
                isOverridden: true,
                choices: [],
              },
              {
                key: 'invoice.number_prefix',
                label: 'Invoice number prefix',
                group: 'invoice',
                valueType: 'STRING',
                value: 'INV',
                defaultValue: 'INV',
                isOverridden: false,
                choices: [],
              },
            ],
          },
        },
      },
    ],
  },

  'PUT /api/v1/organization/settings/{key}': {
    summary: 'Set a setting',
    description: `
Overrule the platform default for one setting.

**\`PUT\`, not \`PATCH\`** — a setting holds exactly one value and this replaces
it. It is not a create either: whether an override row already exists is an
implementation detail, so this always answers \`200\` with the setting as it now
resolves rather than \`201\` on first write.

\`value\` is validated against the setting's declared \`valueType\` and, for an
\`ENUM\`, against its \`choices\`. A key that no definition declares is \`404\` —
settings are a closed set, not a free-form bag.
`.trim(),
    response: settingItem,
    message: 'Setting saved',
    params: { key: KEY_NOTE },
    requestExamples: [
      {
        summary: 'Switch the clinic to a 24-hour clock',
        value: { value: '24H' },
      },
      {
        summary: 'Longer default appointments',
        description: 'A `NUMBER` setting — send the number, not a string.',
        value: { value: 20 },
      },
    ],
    responseExamples: [
      {
        summary: 'Saved',
        value: {
          success: true,
          message: 'Setting saved',
          data: {
            key: 'locale.time_format',
            label: 'Time format',
            group: 'locale',
            valueType: 'ENUM',
            value: '24H',
            defaultValue: '12H',
            isOverridden: true,
            choices: [
              { value: '12H', label: '12-hour (9:30 AM)' },
              { value: '24H', label: '24-hour (09:30)' },
            ],
          },
        },
      },
    ],
  },

  'DELETE /api/v1/organization/settings/{key}': {
    summary: 'Reset a setting',
    description: `
Clear this clinic's override and fall back to whatever it was overruling.

**\`DELETE\` rather than \`PUT { "value": null }\`**, because \`null\` is a value
a JSON setting may legitimately hold — there would otherwise be no way to say
"no opinion" as distinct from "explicitly nothing".

Returns the setting as it now resolves, with \`isOverridden: false\` and the
default in \`value\`, so the caller does not have to re-read the list to find out
what took over. Clearing a setting that was never overridden is not an error.
`.trim(),
    response: settingItem,
    message: 'Setting reset',
    params: { key: KEY_NOTE },
    responseExamples: [
      {
        summary: 'Back to the platform default',
        description: '`value` now equals `defaultValue`, and `isOverridden` has gone false.',
        value: {
          success: true,
          message: 'Setting reset',
          data: {
            key: 'locale.time_format',
            label: 'Time format',
            group: 'locale',
            valueType: 'ENUM',
            value: '12H',
            defaultValue: '12H',
            isOverridden: false,
            choices: [
              { value: '12H', label: '12-hour (9:30 AM)' },
              { value: '24H', label: '24-hour (09:30)' },
            ],
          },
        },
      },
    ],
  },
};
