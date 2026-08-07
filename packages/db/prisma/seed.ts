/**
 * Idempotent seed. Safe to re-run — everything upserts on a natural key.
 *
 * Seeds:
 *   1. the permission catalogue          (from @rcln/permissions)
 *   2. system roles + their grants       (organization_id NULL, is_system true)
 *   3. setting definitions
 *   4. subscription plans
 *   5. the super admin — the one account never created through the UI
 */
import { config as loadEnv } from 'dotenv';
import { hash } from '@node-rs/argon2';

// Single .env at the repo root; this runs with cwd=packages/db.
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/index.js';
import {
  ALL_PERMISSIONS,
  SYSTEM_ROLE_DEFINITIONS,
  moduleOf,
  type PermissionCode,
} from '@rcln/permissions';

// Seeds write platform-wide rows (permissions, system roles, plans) that no
// tenant owns, so this connects as the OWNER role, which RLS does not restrict.
const connectionString = process.env['DIRECT_DATABASE_URL'];
if (!connectionString) throw new Error('DIRECT_DATABASE_URL is required to seed');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Argon2id parameters. OWASP baseline: 19 MiB memory, 2 iterations, 1 lane.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

function describe(code: PermissionCode): string {
  const [, ...rest] = code.split('.');
  return rest.join(' ').replace(/_/g, ' ');
}

async function seedPermissions(): Promise<Map<PermissionCode, string>> {
  const ids = new Map<PermissionCode, string>();

  for (const code of ALL_PERMISSIONS) {
    const parts = code.split('.');
    const row = await prisma.permission.upsert({
      where: { code },
      update: {},
      create: {
        code,
        module: moduleOf(code),
        action: parts[parts.length - 1] ?? 'unknown',
        description: describe(code),
      },
    });
    ids.set(code, row.id);
  }

  console.warn(`  permissions      ${ids.size}`);
  return ids;
}

async function seedSystemRoles(permissionIds: Map<PermissionCode, string>): Promise<void> {
  for (const def of SYSTEM_ROLE_DEFINITIONS) {
    // Prisma cannot target a compound unique with a NULL component, so this is
    // find-then-write rather than upsert. Uniqueness is still guaranteed by the
    // NULLS NOT DISTINCT index in the 20260725060000 migration.
    const existing = await prisma.role.findFirst({
      where: { organizationId: null, code: def.code },
    });

    const role = existing
      ? await prisma.role.update({
          where: { id: existing.id },
          data: { name: def.name, description: def.description, scopeLevel: def.scopeLevel },
        })
      : await prisma.role.create({
          data: {
            organizationId: null,
            code: def.code,
            name: def.name,
            description: def.description,
            scopeLevel: def.scopeLevel,
            isSystem: true,
          },
        });

    // Re-sync grants so editing roles.ts and re-seeding actually takes effect.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: def.permissions
        .map((code) => permissionIds.get(code))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
  }

  console.warn(`  system roles     ${SYSTEM_ROLE_DEFINITIONS.length}`);
}

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
async function seedSettingDefinitions(): Promise<void> {
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

/*
 * `tax_registrations` IS DELIBERATELY NOT SEEDED, AND THAT IS THE FEATURE.
 *
 * A row in that table is an assertion that rcln is registered to collect a tax
 * in a jurisdiction — a legal claim, not a default. Seeding a plausible-looking
 * Indian GST row would make every development and staging invoice carry 18% GST
 * against a GSTIN that does not exist, and the first person to copy the seed
 * into production would start collecting tax nobody can remit.
 *
 * An empty table means every supply resolves to NOT_REGISTERED and nothing is
 * taxed, with the reason recorded on each invoice. That is the correct state for
 * a business that has not registered anywhere yet. Add rows when a registration
 * actually exists — through a platform admin, not through this file.
 *
 * See the model comment in schema.prisma and `resolveTax` in @rcln/billing.
 */
async function seedPlans(): Promise<void> {
  const plans = [
    {
      code: 'STARTER',
      name: 'Starter',
      tagline: 'A single clinic finding its feet',
      trialDays: 14,
      sortOrder: 1,
      prices: { INR: 1499, USD: 19, EUR: 19, GBP: 16, AED: 69, SGD: 25, AUD: 29 },
      features: {
        max_branches: 1,
        max_users: 10,
        max_patients: 2000,
        pharmacy_module: false,
        lab_module: false,
        whatsapp_notifications: true,
        custom_domain: false,
      },
    },
    {
      code: 'GROWTH',
      name: 'Growth',
      tagline: 'Multi-branch, pharmacy and lab included',
      trialDays: 14,
      sortOrder: 2,
      prices: { INR: 4999, USD: 59, EUR: 55, GBP: 49, AED: 219, SGD: 79, AUD: 89 },
      features: {
        max_branches: 5,
        max_users: 50,
        max_patients: 25000,
        pharmacy_module: true,
        lab_module: true,
        whatsapp_notifications: true,
        custom_domain: false,
      },
    },
    {
      code: 'ENTERPRISE',
      name: 'Enterprise',
      tagline: 'Hospital chains, unlimited branches',
      trialDays: 30,
      sortOrder: 3,
      prices: { INR: 14999, USD: 179, EUR: 169, GBP: 149, AED: 659, SGD: 239, AUD: 269 },
      features: {
        max_branches: -1,
        max_users: -1,
        max_patients: -1,
        pharmacy_module: true,
        lab_module: true,
        whatsapp_notifications: true,
        custom_domain: true,
      },
    },
  ];

  for (const p of plans) {
    const plan = await prisma.plan.upsert({
      where: { code: p.code },
      update: { name: p.name, tagline: p.tagline, trialDays: p.trialDays, sortOrder: p.sortOrder },
      create: {
        code: p.code,
        name: p.name,
        tagline: p.tagline,
        trialDays: p.trialDays,
        sortOrder: p.sortOrder,
      },
    });

    /*
     * Priced per currency, and NOT converted from the rupee figure.
     *
     * A published price is a commercial decision, not an exchange-rate
     * calculation: $59 is a price somebody chose, and ₹4999 at today's rate is
     * not. Converting here would also make every plan's price move whenever the
     * rate did, which is not something a customer or a finance team can work
     * with. `@rcln/payments` deliberately contains no FX for the same reason.
     *
     * A currency a plan has no row for is simply not purchasable in that
     * currency — `listPlans` omits the plan rather than showing a price that
     * would fail at checkout.
     *
     * Annual is ten months' price in every currency: two months free, which is
     * the discount the marketing page states.
     */
    for (const [currency, monthly] of Object.entries(p.prices)) {
      for (const [interval, amount] of [
        ['MONTH', monthly],
        ['YEAR', monthly * 10],
      ] as const) {
        await prisma.planPrice.upsert({
          where: {
            planId_currency_billingInterval: {
              planId: plan.id,
              currency,
              billingInterval: interval,
            },
          },
          update: { amount },
          create: { planId: plan.id, currency, billingInterval: interval, amount },
        });
      }
    }

    for (const [featureKey, value] of Object.entries(p.features)) {
      const isBool = typeof value === 'boolean';
      const payload = {
        valueType: (isBool ? 'BOOL' : 'INT') as 'BOOL' | 'INT',
        intValue: isBool ? null : (value as number),
        boolValue: isBool ? (value as boolean) : null,
      };
      await prisma.planFeature.upsert({
        where: { planId_featureKey: { planId: plan.id, featureKey } },
        update: payload,
        create: { planId: plan.id, featureKey, ...payload },
      });
    }
  }

  console.warn(`  plans            ${plans.length}`);
}

/**
 * Clinical masters, seeded as PLATFORM rows (`organizationId = null`).
 *
 * Every clinic reads these; a clinic that needs one we have not thought of adds
 * its own org-scoped row through `doctor.master.manage` rather than waiting for
 * a deploy. The RLS policy is deliberately read-permissive and write-strict, so
 * a tenant can never add to this list — see enable-rls.sql.
 *
 * `upsert` on the (organizationId, code) pair, so re-seeding is safe and a
 * renamed specialty updates in place rather than duplicating.
 *
 * Sub-specialties reference their parent by CODE and are inserted in a second
 * pass, so the order of this list does not matter.
 */
const SPECIALTIES: { code: string; name: string; parent?: string }[] = [
  { code: 'GENERAL_MEDICINE', name: 'General Medicine' },
  { code: 'GENERAL_SURGERY', name: 'General Surgery' },
  { code: 'FAMILY_MEDICINE', name: 'Family Medicine' },
  { code: 'PAEDIATRICS', name: 'Paediatrics' },
  { code: 'NEONATOLOGY', name: 'Neonatology', parent: 'PAEDIATRICS' },
  { code: 'OBSTETRICS_GYNAECOLOGY', name: 'Obstetrics & Gynaecology' },
  { code: 'CARDIOLOGY', name: 'Cardiology' },
  { code: 'INTERVENTIONAL_CARDIOLOGY', name: 'Interventional Cardiology', parent: 'CARDIOLOGY' },
  { code: 'DERMATOLOGY', name: 'Dermatology' },
  { code: 'TRICHOLOGY', name: 'Trichology', parent: 'DERMATOLOGY' },
  { code: 'COSMETOLOGY', name: 'Cosmetology', parent: 'DERMATOLOGY' },
  { code: 'ORTHOPAEDICS', name: 'Orthopaedics' },
  { code: 'SPINE_SURGERY', name: 'Spine Surgery', parent: 'ORTHOPAEDICS' },
  { code: 'SPORTS_MEDICINE', name: 'Sports Medicine', parent: 'ORTHOPAEDICS' },
  { code: 'ENT', name: 'ENT (Otorhinolaryngology)' },
  { code: 'OPHTHALMOLOGY', name: 'Ophthalmology' },
  { code: 'DENTISTRY', name: 'Dentistry' },
  { code: 'ORTHODONTICS', name: 'Orthodontics', parent: 'DENTISTRY' },
  { code: 'ENDODONTICS', name: 'Endodontics', parent: 'DENTISTRY' },
  { code: 'PERIODONTICS', name: 'Periodontics', parent: 'DENTISTRY' },
  { code: 'ORAL_MAXILLOFACIAL_SURGERY', name: 'Oral & Maxillofacial Surgery', parent: 'DENTISTRY' },
  { code: 'NEUROLOGY', name: 'Neurology' },
  { code: 'NEUROSURGERY', name: 'Neurosurgery' },
  { code: 'PSYCHIATRY', name: 'Psychiatry' },
  { code: 'CLINICAL_PSYCHOLOGY', name: 'Clinical Psychology' },
  { code: 'GASTROENTEROLOGY', name: 'Gastroenterology' },
  { code: 'HEPATOLOGY', name: 'Hepatology', parent: 'GASTROENTEROLOGY' },
  { code: 'NEPHROLOGY', name: 'Nephrology' },
  { code: 'UROLOGY', name: 'Urology' },
  { code: 'ENDOCRINOLOGY', name: 'Endocrinology' },
  { code: 'DIABETOLOGY', name: 'Diabetology', parent: 'ENDOCRINOLOGY' },
  { code: 'PULMONOLOGY', name: 'Pulmonology' },
  { code: 'RHEUMATOLOGY', name: 'Rheumatology' },
  { code: 'ONCOLOGY', name: 'Oncology' },
  { code: 'MEDICAL_ONCOLOGY', name: 'Medical Oncology', parent: 'ONCOLOGY' },
  { code: 'SURGICAL_ONCOLOGY', name: 'Surgical Oncology', parent: 'ONCOLOGY' },
  { code: 'HAEMATOLOGY', name: 'Haematology' },
  { code: 'RADIOLOGY', name: 'Radiology' },
  { code: 'PATHOLOGY', name: 'Pathology' },
  { code: 'ANAESTHESIOLOGY', name: 'Anaesthesiology' },
  { code: 'EMERGENCY_MEDICINE', name: 'Emergency Medicine' },
  { code: 'PHYSIOTHERAPY', name: 'Physiotherapy' },
  { code: 'NUTRITION_DIETETICS', name: 'Nutrition & Dietetics' },
  { code: 'AYURVEDA', name: 'Ayurveda' },
  { code: 'HOMEOPATHY', name: 'Homeopathy' },
  { code: 'PLASTIC_SURGERY', name: 'Plastic & Reconstructive Surgery' },
  { code: 'VASCULAR_SURGERY', name: 'Vascular Surgery' },
  { code: 'GERIATRICS', name: 'Geriatrics' },
];

const QUALIFICATIONS: { code: string; name: string }[] = [
  { code: 'MBBS', name: 'MBBS' },
  { code: 'MD', name: 'MD — Doctor of Medicine' },
  { code: 'MS', name: 'MS — Master of Surgery' },
  { code: 'DNB', name: 'DNB — Diplomate of National Board' },
  { code: 'DM', name: 'DM — Doctorate of Medicine (super-specialty)' },
  { code: 'MCH', name: 'MCh — Magister Chirurgiae (super-specialty)' },
  { code: 'DIPLOMA', name: 'Post-graduate Diploma' },
  { code: 'BDS', name: 'BDS — Bachelor of Dental Surgery' },
  { code: 'MDS', name: 'MDS — Master of Dental Surgery' },
  { code: 'BAMS', name: 'BAMS — Ayurvedic Medicine & Surgery' },
  { code: 'BHMS', name: 'BHMS — Homeopathic Medicine & Surgery' },
  { code: 'BUMS', name: 'BUMS — Unani Medicine & Surgery' },
  { code: 'BPT', name: 'BPT — Bachelor of Physiotherapy' },
  { code: 'MPT', name: 'MPT — Master of Physiotherapy' },
  { code: 'BSC_NURSING', name: 'BSc Nursing' },
  { code: 'MSC_NURSING', name: 'MSc Nursing' },
  { code: 'GNM', name: 'GNM — General Nursing & Midwifery' },
  { code: 'ANM', name: 'ANM — Auxiliary Nurse Midwife' },
  { code: 'BPHARM', name: 'B.Pharm' },
  { code: 'MPHARM', name: 'M.Pharm' },
  { code: 'DPHARM', name: 'D.Pharm' },
  { code: 'DMLT', name: 'DMLT — Medical Laboratory Technology' },
  { code: 'BMLT', name: 'BMLT — Bachelor of Medical Lab Technology' },
  { code: 'MPH', name: 'MPH — Master of Public Health' },
  { code: 'PHD', name: 'PhD' },
  { code: 'FRCS', name: 'FRCS — Fellow, Royal College of Surgeons' },
  { code: 'MRCP', name: 'MRCP — Member, Royal College of Physicians' },
];

/**
 * Job titles, seeded as PLATFORM rows so a new clinic's invite form is not empty
 * on day one. A clinic adds its own through `iam.designation.manage`; those are
 * org-scoped and invisible to everyone else.
 *
 * Deliberately broader than the role list: a role is what someone may DO
 * (permissions), a designation is what they ARE CALLED. Three consultants can
 * share the DOCTOR role and hold three different titles.
 */
const DESIGNATIONS: { code: string; name: string }[] = [
  { code: 'CONSULTANT', name: 'Consultant' },
  { code: 'SENIOR_CONSULTANT', name: 'Senior Consultant' },
  { code: 'JUNIOR_CONSULTANT', name: 'Junior Consultant' },
  { code: 'VISITING_CONSULTANT', name: 'Visiting Consultant' },
  { code: 'RESIDENT_MEDICAL_OFFICER', name: 'Resident Medical Officer' },
  { code: 'MEDICAL_OFFICER', name: 'Medical Officer' },
  { code: 'DUTY_DOCTOR', name: 'Duty Doctor' },
  { code: 'HEAD_OF_DEPARTMENT', name: 'Head of Department' },
  { code: 'MEDICAL_SUPERINTENDENT', name: 'Medical Superintendent' },
  { code: 'NURSING_SUPERINTENDENT', name: 'Nursing Superintendent' },
  { code: 'HEAD_NURSE', name: 'Head Nurse' },
  { code: 'STAFF_NURSE', name: 'Staff Nurse' },
  { code: 'TRAINEE_NURSE', name: 'Trainee Nurse' },
  { code: 'WARD_BOY', name: 'Ward Attendant' },
  { code: 'FRONT_DESK_EXECUTIVE', name: 'Front Desk Executive' },
  { code: 'RECEPTIONIST', name: 'Receptionist' },
  { code: 'CLINIC_MANAGER', name: 'Clinic Manager' },
  { code: 'BRANCH_MANAGER', name: 'Branch Manager' },
  { code: 'ADMINISTRATOR', name: 'Administrator' },
  { code: 'ACCOUNTS_EXECUTIVE', name: 'Accounts Executive' },
  { code: 'ACCOUNTS_MANAGER', name: 'Accounts Manager' },
  { code: 'BILLING_EXECUTIVE', name: 'Billing Executive' },
  { code: 'PHARMACIST', name: 'Pharmacist' },
  { code: 'CHIEF_PHARMACIST', name: 'Chief Pharmacist' },
  { code: 'LAB_TECHNICIAN', name: 'Lab Technician' },
  { code: 'SENIOR_LAB_TECHNICIAN', name: 'Senior Lab Technician' },
  { code: 'PATHOLOGIST', name: 'Pathologist' },
  { code: 'RADIOLOGIST', name: 'Radiologist' },
  { code: 'RADIOGRAPHER', name: 'Radiographer' },
  { code: 'PHYSIOTHERAPIST', name: 'Physiotherapist' },
  { code: 'DIETICIAN', name: 'Dietician' },
  { code: 'COUNSELLOR', name: 'Counsellor' },
  { code: 'IT_ADMINISTRATOR', name: 'IT Administrator' },
  { code: 'HOUSEKEEPING', name: 'Housekeeping' },
  { code: 'SECURITY', name: 'Security' },
];

/**
 * Which titles fit which built-in role, so a Receptionist cannot be made a
 * Radiologist.
 *
 * ⚠️ A TITLE ABSENT FROM EVERY LIST HERE FITS EVERY ROLE.
 *   The eligibility query treats "no visible pairing at all" as "fits
 *   anywhere", not "fits nowhere" — otherwise a clinic that adds a title and
 *   forgets to map it watches it vanish from every menu. So the omissions below
 *   are deliberate, not oversights: IT_ADMINISTRATOR, HOUSEKEEPING and SECURITY
 *   are support roles that any of the built-in roles might carry, and pinning
 *   them to one would be a guess.
 *
 * SUPER_ADMIN and PATIENT get nothing: neither is a staff role, and the invite
 * service already refuses a PLATFORM-scoped role outright.
 */
const ROLE_DESIGNATIONS: Record<string, string[]> = {
  ORG_OWNER: ['ADMINISTRATOR', 'CLINIC_MANAGER', 'MEDICAL_SUPERINTENDENT', 'HEAD_OF_DEPARTMENT'],
  ORG_ADMIN: ['ADMINISTRATOR', 'CLINIC_MANAGER', 'BRANCH_MANAGER', 'MEDICAL_SUPERINTENDENT'],
  BRANCH_ADMIN: ['BRANCH_MANAGER', 'CLINIC_MANAGER', 'ADMINISTRATOR'],
  DOCTOR: [
    'CONSULTANT',
    'SENIOR_CONSULTANT',
    'JUNIOR_CONSULTANT',
    'VISITING_CONSULTANT',
    'RESIDENT_MEDICAL_OFFICER',
    'MEDICAL_OFFICER',
    'DUTY_DOCTOR',
    'HEAD_OF_DEPARTMENT',
    'MEDICAL_SUPERINTENDENT',
    'PHYSIOTHERAPIST',
    'DIETICIAN',
    'COUNSELLOR',
  ],
  NURSE: ['NURSING_SUPERINTENDENT', 'HEAD_NURSE', 'STAFF_NURSE', 'TRAINEE_NURSE', 'WARD_BOY'],
  RECEPTIONIST: ['FRONT_DESK_EXECUTIVE', 'RECEPTIONIST', 'CLINIC_MANAGER'],
  LAB_ASSISTANT: ['LAB_TECHNICIAN', 'RADIOGRAPHER'],
  LAB_MANAGER: [
    'SENIOR_LAB_TECHNICIAN',
    'LAB_TECHNICIAN',
    'PATHOLOGIST',
    'RADIOLOGIST',
    'RADIOGRAPHER',
  ],
  PHARMACIST: ['PHARMACIST', 'CHIEF_PHARMACIST'],
  ACCOUNTANT: ['ACCOUNTS_EXECUTIVE', 'ACCOUNTS_MANAGER', 'BILLING_EXECUTIVE'],
};

async function seedRoleDesignations(): Promise<void> {
  const roles = new Map(
    (
      await prisma.role.findMany({
        where: { organizationId: null },
        select: { id: true, code: true },
      })
    ).map((r) => [r.code, r.id])
  );

  const designations = new Map(
    (
      await prisma.designation.findMany({
        where: { organizationId: null },
        select: { id: true, code: true },
      })
    ).map((d) => [d.code, d.id])
  );

  let pairs = 0;

  for (const [roleCode, designationCodes] of Object.entries(ROLE_DESIGNATIONS)) {
    const roleId = roles.get(roleCode);
    if (!roleId) continue;

    for (const designationCode of designationCodes) {
      const designationId = designations.get(designationCode);
      if (!designationId) {
        throw new Error(`ROLE_DESIGNATIONS names ${designationCode}, which is not in DESIGNATIONS`);
      }

      // findFirst then create, for the same NULLS NOT DISTINCT reason as above.
      const existing = await prisma.roleDesignation.findFirst({
        where: { organizationId: null, roleId, designationId },
        select: { id: true },
      });
      if (!existing) {
        await prisma.roleDesignation.create({
          data: { organizationId: null, roleId, designationId },
        });
      }
      pairs += 1;
    }
  }

  console.warn(`  role↔title       ${pairs}`);
}

async function seedDesignations(): Promise<void> {
  // findFirst then create/update, not upsert: the unique is
  // (organization_id, code) NULLS NOT DISTINCT and Prisma refuses to build a
  // `where` for a compound unique with a nullable component. Same constraint,
  // and the same workaround, as the settings and specialty seeds. See PITFALLS.
  for (const d of DESIGNATIONS) {
    const existing = await prisma.designation.findFirst({
      where: { organizationId: null, code: d.code },
      select: { id: true },
    });
    if (existing) {
      await prisma.designation.update({ where: { id: existing.id }, data: { name: d.name } });
    } else {
      await prisma.designation.create({
        data: { organizationId: null, code: d.code, name: d.name },
      });
    }
  }

  console.warn(`  designations     ${DESIGNATIONS.length}`);
}

async function seedClinicalMasters(): Promise<void> {
  /*
   * `findFirst` then create/update rather than `upsert`.
   *
   * The unique is (organization_id, code) NULLS NOT DISTINCT, and Prisma refuses
   * to build a `where` for a compound unique with a nullable component —
   * organization_id is null on every platform row. Same constraint, and the same
   * workaround, as the settings seed. See PITFALLS.
   */
  for (const spec of SPECIALTIES) {
    const existing = await prisma.specialty.findFirst({
      where: { organizationId: null, code: spec.code },
      select: { id: true },
    });
    if (existing) {
      await prisma.specialty.update({ where: { id: existing.id }, data: { name: spec.name } });
    } else {
      await prisma.specialty.create({
        data: { organizationId: null, code: spec.code, name: spec.name },
      });
    }
  }

  // Second pass: parents are guaranteed to exist by now, so the source list can
  // be written in whatever order reads best.
  const byCode = new Map(
    (
      await prisma.specialty.findMany({
        where: { organizationId: null },
        select: { id: true, code: true },
      })
    ).map((s) => [s.code, s.id])
  );

  for (const spec of SPECIALTIES) {
    if (!spec.parent) continue;
    const id = byCode.get(spec.code);
    const parentId = byCode.get(spec.parent);
    if (id && parentId) {
      await prisma.specialty.update({ where: { id }, data: { parentId } });
    }
  }

  for (const q of QUALIFICATIONS) {
    const existing = await prisma.qualification.findFirst({
      where: { organizationId: null, code: q.code },
      select: { id: true },
    });
    if (existing) {
      await prisma.qualification.update({ where: { id: existing.id }, data: { name: q.name } });
    } else {
      await prisma.qualification.create({
        data: { organizationId: null, code: q.code, name: q.name },
      });
    }
  }

  console.warn(`  specialties      ${SPECIALTIES.length}`);
  console.warn(`  qualifications   ${QUALIFICATIONS.length}`);
}

async function seedSuperAdmin(): Promise<void> {
  const email = process.env['SUPERADMIN_EMAIL'] ?? 'superadmin@rcln.local';
  const password = process.env['SUPERADMIN_PASSWORD'];
  const fullName = process.env['SUPERADMIN_NAME'] ?? 'Platform Super Admin';

  if (!password) {
    console.warn('  super admin      SKIPPED (SUPERADMIN_PASSWORD not set)');
    return;
  }

  if (process.env['NODE_ENV'] === 'production' && password.length < 16) {
    throw new Error('SUPERADMIN_PASSWORD must be at least 16 characters in production');
  }

  const user = await prisma.user.upsert({
    where: { email },
    update: { isPlatformAdmin: true, status: 'ACTIVE' },
    create: {
      email,
      fullName,
      passwordHash: await hash(password, ARGON2),
      status: 'ACTIVE',
      isPlatformAdmin: true,
      emailVerifiedAt: new Date(),
    },
  });

  console.warn(`  super admin      ${user.email}`);
}

async function main(): Promise<void> {
  console.warn('\nSeeding rcln…\n');

  const permissionIds = await seedPermissions();
  await seedSystemRoles(permissionIds);
  await seedSettingDefinitions();
  await seedDesignations();
  // After both roles and designations exist — it pairs them by code.
  await seedRoleDesignations();
  await seedClinicalMasters();
  await seedPlans();
  await seedSuperAdmin();

  console.warn('\nDone.\n');
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
