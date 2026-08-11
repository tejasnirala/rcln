/**
 * The setting catalogue — every key the settings screen can show.
 */
import { Prisma } from '../../generated/prisma/index.js';

import { prisma } from './client.js';

/**
 * The twelve months, as the financial-year setting offers them.
 *
 * Numbers, because that is what the column holds and what any date arithmetic
 * downstream will do with it — but nobody picks "4" from a list, they pick
 * April. This is exactly the case `allowed_values` exists for.
 */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
].map((label, index) => ({ value: index + 1, label }));

/**
 * The setting catalogue.
 *
 * `description` is the short name the settings screen puts on the row.
 * `helpText` is what it is FOR — written for whoever runs the clinic, saying
 * what changing it actually does, because "Fallback tax rate when a billable
 * item defines none" is a description of the column, not an explanation.
 * `allowedValues` closes the set: present means the API refuses anything else
 * and the screen renders a select. Omit it for genuinely open values.
 */
export async function seedSettingDefinitions(): Promise<void> {
  const defs = [
    {
      key: 'appointment.slot_minutes',
      module: 'appointment',
      dataType: 'INT' as const,
      defaultValue: 15,
      allowedScopes: ['ORGANIZATION', 'BRANCH', 'DOCTOR'],
      description: 'Consultation length',
      helpText:
        'How long one appointment blocks out in the calendar, in minutes. It decides how many slots a doctor’s day is divided into. A doctor who needs longer can be given their own length.',
      // Deliberately open: a physiotherapist booking 45 minutes and a screening
      // camp booking 5 are both real, and a list would have to guess.
    },
    {
      key: 'appointment.allow_online_booking',
      module: 'appointment',
      dataType: 'BOOL' as const,
      defaultValue: true,
      allowedScopes: ['ORGANIZATION', 'BRANCH', 'DOCTOR'],
      description: 'Patient self-booking',
      helpText:
        'Whether patients can book themselves an appointment from the portal. Turn it off and every appointment has to be made by your staff. Existing bookings are not affected.',
    },
    {
      key: 'appointment.reminder_hours_before',
      module: 'appointment',
      dataType: 'JSON' as const,
      defaultValue: [24, 2],
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Appointment reminders',
      helpText:
        'How many hours before an appointment each reminder goes out. [24, 2] sends one the day before and one two hours ahead. An empty list sends none.',
    },
    {
      key: 'billing.invoice_prefix',
      module: 'billing',
      dataType: 'STRING' as const,
      defaultValue: 'INV',
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Invoice number prefix',
      helpText:
        'The letters in front of every invoice number this clinic issues — INV becomes INV-000123. Changing it does not renumber invoices you have already raised.',
    },
    {
      key: 'billing.default_tax_percent',
      module: 'billing',
      dataType: 'DECIMAL' as const,
      defaultValue: 0,
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Default tax rate',
      helpText:
        'The GST rate applied to a billable item that does not carry one of its own. Most clinical services are exempt, which is why this starts at 0. Items with their own rate ignore it.',
    },
    {
      /**
       * ⚠️ IN MINOR UNITS, WHICH IS WHY 100 IS "TO THE RUPEE" AND NOT "A
       *   HUNDRED RUPEES". The engine rounds the grand total to the nearest
       *   multiple of this many minor units, so 100 rounds ₹247.60 to ₹248 and
       *   `1` — the default — rounds nothing at all. Naming it in major units
       *   would make the value depend on the currency, and a clinic billing in
       *   yen has no minor unit to round away.
       *
       * ⚠️ AND IT IS READ AGAIN AT EVERY RE-PRICE, WHICH IS THE WHOLE REASON IT
       *   IS A SETTING. It used to be a request parameter that was never stored,
       *   so finalisation — which re-prices from the stored inputs — dropped it,
       *   and the document the patient received disagreed with the draft the
       *   cashier approved. See `priceDraftInvoice`.
       */
      key: 'billing.cash_rounding_minor',
      module: 'billing',
      dataType: 'INT' as const,
      defaultValue: 1,
      // BRANCH as well as ORGANIZATION: a cash desk that rounds and an
      // insurance-billing desk that does not is one hospital, not two.
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Round cash totals',
      helpText:
        'Whether the total on a bill is rounded before the patient pays it, so the counter is not counting out small change. It moves the total only — the tax is worked out first and is never rounded away. In India, “to the whole unit” means to the rupee. Off by default.',
      /*
       * ⚠️ LABELLED IN UNITS AND NOT IN RUPEES, BECAUSE THE COLUMN IS MINOR UNITS
       *   AND THE CLINIC MAY NOT BE INDIAN (Phase 2b). "To the nearest rupee" is
       *   100 minor units in INR and meaningless in JPY, which has none — the
       *   labels therefore name the multiple and the help text gives the Indian
       *   reading.
       */
      allowedValues: [
        { value: 1, label: 'No rounding' },
        { value: 50, label: 'To the nearest half unit' },
        { value: 100, label: 'To the nearest whole unit' },
        { value: 500, label: 'To the nearest five units' },
      ],
    },
    {
      key: 'billing.financial_year_start_month',
      module: 'billing',
      dataType: 'INT' as const,
      defaultValue: 4,
      allowedScopes: ['ORGANIZATION'],
      description: 'Financial year starts',
      helpText:
        'The month your books open. Indian practices run April to March, which is the default. It decides how invoice series are numbered and where reports draw the year boundary.',
      allowedValues: MONTHS,
    },
    {
      key: 'inventory.expiry_alert_days',
      module: 'inventory',
      dataType: 'JSON' as const,
      defaultValue: [90, 60, 30, 7],
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Expiry warnings',
      helpText:
        'How many days before a batch expires you want warning. [90, 60, 30, 7] warns four times, with the last a week out. Earlier warnings are what let stock be returned or used first.',
    },
    {
      key: 'inventory.batch_selection_strategy',
      module: 'inventory',
      dataType: 'STRING' as const,
      defaultValue: 'FEFO',
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Which batch to dispense',
      helpText:
        'Which batch the pharmacy is offered first. First expiry, first out sends the stock closest to expiring — this is what you want for medicines. First in, first out sends the oldest delivery.',
      allowedValues: [
        { value: 'FEFO', label: 'First expiry, first out' },
        { value: 'FIFO', label: 'First in, first out' },
      ],
    },
    {
      /**
       * ⚠️ A DISPLAY SETTING, NOT A STORAGE ONE, AND THE DISTINCTION IS THE WHOLE
       *   RULE. Every instant rcln holds is UTC in a `timestamptz` and travels as
       *   an ISO string with a `Z`; every screen renders it in the branch's IANA
       *   zone. This decides only whether that rendering reads `4:40 pm` or
       *   `16:40`. Nothing parses it, nothing stores against it, and no
       *   arithmetic anywhere depends on it.
       *
       * ⚠️ BRANCH AS WELL AS ORGANIZATION. A group running a hospital wing and a
       *   walk-in clinic genuinely reads its two diaries differently, and the
       *   resolver already walks BRANCH before ORGANIZATION.
       *
       * The default is 12-hour because most of the clinics rcln is built for
       * write `4:40 pm` on the appointment card, and a diary that disagrees with
       * the card is a receptionist checking every afternoon slot twice.
       */
      key: 'locale.time_format',
      module: 'locale',
      dataType: 'STRING' as const,
      defaultValue: '12H',
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Clock format',
      helpText:
        'Whether times are shown as 4:40 pm or 16:40. It changes how every appointment, chart entry and report reads on screen — not what is stored, and not the time zone your clinic keeps its diary in.',
      allowedValues: [
        { value: '12H', label: '12-hour — 4:40 pm' },
        { value: '24H', label: '24-hour — 16:40' },
      ],
    },
    {
      key: 'notification.default_channel',
      module: 'notification',
      dataType: 'STRING' as const,
      defaultValue: 'WHATSAPP',
      allowedScopes: ['ORGANIZATION', 'BRANCH', 'USER', 'PATIENT'],
      description: 'How messages are sent',
      helpText:
        'Where reminders, receipts and reports go by default. A patient who has asked for something else gets that instead — this is only the starting point.',
      allowedValues: [
        { value: 'WHATSAPP', label: 'WhatsApp' },
        { value: 'SMS', label: 'SMS' },
        { value: 'EMAIL', label: 'Email' },
      ],
    },
    {
      key: 'patient.uhid_prefix',
      module: 'patient',
      dataType: 'STRING' as const,
      defaultValue: 'P',
      allowedScopes: ['ORGANIZATION'],
      description: 'Patient number prefix',
      helpText:
        'The letters in front of every patient’s hospital number — P becomes P-000451. Patients already registered keep the number they have, so changing this splits your records into two shapes.',
    },
    {
      key: 'patient.mrn_prefix',
      module: 'patient',
      dataType: 'STRING' as const,
      defaultValue: 'MRN',
      /*
       * BRANCH as well as ORGANIZATION, unlike `patient.uhid_prefix` above.
       * The MRN series is per branch, so a group that wants its Whitefield
       * records to read WF0001 and its Indiranagar ones IN0001 sets this at the
       * branch. A UHID is org-wide and has no equivalent choice to make.
       */
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Record number prefix',
      helpText:
        'The letters in front of the record number a patient gets at each clinic — MRN becomes MRN000451. Each clinic counts separately, so two branches both start at 1. Patients already registered keep the number they have.',
    },
    {
      key: 'staff.employee_code_prefix',
      module: 'staff',
      dataType: 'STRING' as const,
      defaultValue: 'EMP',
      allowedScopes: ['ORGANIZATION'],
      description: 'Employee code prefix',
      helpText:
        'The letters in front of every staff member’s employee code — EMP becomes EMP0001. It is issued when someone accepts their invitation. People already on the team keep the code they have, so changing this splits your staff list into two shapes.',
    },
    {
      key: 'security.session_idle_timeout_minutes',
      module: 'security',
      dataType: 'INT' as const,
      defaultValue: 60,
      allowedScopes: ['PLATFORM', 'ORGANIZATION'],
      description: 'Sign out when idle',
      helpText:
        'How long a signed-in session survives with nobody using it. Shorter is safer on a shared front-desk machine; longer interrupts a doctor mid-consultation less often.',
      allowedValues: [
        { value: 15, label: '15 minutes' },
        { value: 30, label: '30 minutes' },
        { value: 60, label: '1 hour' },
        { value: 120, label: '2 hours' },
        { value: 480, label: '8 hours — a full shift' },
      ],
    },
    {
      key: 'security.require_mfa_for_admins',
      module: 'security',
      dataType: 'BOOL' as const,
      defaultValue: false,
      allowedScopes: ['PLATFORM', 'ORGANIZATION'],
      description: 'Second step for administrators',
      helpText:
        'Whether owners and administrators must enter a code from an authenticator app as well as their password. It protects the accounts that can see every patient record and change everyone’s access.',
    },
  ];

  for (const d of defs) {
    await prisma.settingDefinition.upsert({
      where: { key: d.key },
      update: {
        module: d.module,
        dataType: d.dataType,
        defaultValue: d.defaultValue,
        allowedScopes: d.allowedScopes,
        description: d.description,
        helpText: d.helpText,
        // `Prisma.DbNull`, not a bare `null`: on a nullable Json column a plain
        // null is ambiguous between "the SQL NULL" and "the JSON literal null",
        // and Prisma refuses it outright. This has to actually clear the
        // column — a setting that STOPS being a closed set would otherwise keep
        // its old choices and the API would keep refusing values it now allows.
        allowedValues: d.allowedValues ?? Prisma.DbNull,
      },
      create: d,
    });
  }

  console.warn(`  settings         ${defs.length}`);
}
