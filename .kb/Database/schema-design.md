# Healthcare SaaS — Database Design (v1)

Multi-tenant, subdomain-routed clinic/hospital management platform.
PostgreSQL 16. Target: a schema that absorbs new _features_ without new _shapes_.

---

## 1. The five decisions everything else follows from

### D1 — Organization is the tenant. Branch is the place.

A single-location clinic and a 3-branch hospital are the **same shape**: one `organization` with one or three `branches`. There is no separate "clinic" concept.

- `alpha.xyz.com` → `organizations.slug = 'alpha'`
- PMCS with branches A/B/C → one org `pmcs`, three `branches` rows
- A clinic that later opens a second location adds a row. No migration.

Every operational table carries `organization_id`. Tables describing something that happens _at a location_ also carry `branch_id`.

### D2 — One `users` table. Roles live on the membership, not the person.

`users` = one login, globally unique email/phone. Everything role-shaped is:

```
memberships          user  ×  organization        (the person belongs to this org)
membership_roles     membership × role × branch_id NULLABLE
```

`branch_id NULL` means **all branches in the org**. This one nullable column is the entire branch-assignment requirement:

| Requirement                                            | Rows in `membership_roles`                         |
| ------------------------------------------------------ | -------------------------------------------------- |
| One admin for all three branches                       | 1 row, `role=ADMIN`, `branch_id=NULL`              |
| A separate admin per branch                            | 3 memberships, each 1 row with its own `branch_id` |
| Admin X manages A+B, admin Y manages A                 | X: 2 rows (A, B). Y: 1 row (A).                    |
| Dr. Sharma: doctor at A, and also front-desk lead at C | 2 rows, different `role_id` + `branch_id`          |
| Doctor working across two different organizations      | 2 memberships (one per org), same `users` row      |

**Branch switching** = the session's `active_branch_id` changes. The UI branch picker is literally `SELECT branch FROM membership_roles WHERE membership.user_id = me`. Super admin (`users.is_platform_admin`) bypasses membership and can impersonate any org/branch — every such switch is written to `audit_logs`.

### D3 — Tenant isolation is enforced by the database, not by the ORM.

Two mechanisms, both non-optional:

1. **Composite foreign keys.** Child tables reference `(organization_id, id)` of the parent, not just `id`:

   ```sql
   ALTER TABLE appointments
     ADD CONSTRAINT fk_appt_patient
     FOREIGN KEY (organization_id, patient_id)
     REFERENCES patients (organization_id, id);
   ```

   It becomes physically impossible to attach org B's patient to org A's appointment — the class of bug the current schema has no defense against.

2. **Row-level security.** Every tenant table gets:
   ```sql
   ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON appointments
     USING (organization_id = current_setting('app.current_org')::uuid);
   CREATE POLICY branch_isolation ON appointments
     USING (branch_id = ANY (current_setting('app.branch_scope')::uuid[]));
   ```
   The app sets `app.current_org` / `app.branch_scope` / `app.current_user` per request from the session. A forgotten `WHERE clinic_id = ?` returns zero rows instead of another clinic's patients.

"A doctor logged into clinic XYZ sees only XYZ data" is therefore not application logic — it's the connection's identity.

### D4 — Nothing is stored as a JSON array of IDs.

The `tooth_diagno.problem_ids` / `hair_diagno.diagnosis_ids` pattern is replaced by real join tables. Where genuine per-specialty variability exists (dental charting vs. trichology vs. dermatology), it is handled by **versioned form templates** (`clinical_form_templates.schema` + `clinical_form_submissions.data`) — JSONB as a _document_, never as a foreign key. Dental charting additionally gets a first-class relational table because tooth-level history must be queryable.

### D5 — One billing spine.

One `invoices` table with typed `invoice_items` covering consultations, procedures, lab tests and pharmacy dispensing. Not two invoice systems, and never a JSON blob of line items. Platform subscription billing is a completely separate set of tables (`subscription_invoices`) — a clinic's revenue and the clinic's bill to you must never share a table.

---

## 2. Conventions (apply to every table)

| Concern     | Rule                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| PK          | `id uuid PRIMARY KEY DEFAULT uuidv7()` — time-sortable, index-friendly                                                                             |
| Tenant      | `organization_id uuid NOT NULL` on every tenant table; `branch_id` where location-scoped                                                           |
| Audit       | `created_at`, `updated_at timestamptz NOT NULL DEFAULT now()`, `created_by`, `updated_by uuid`                                                     |
| Soft delete | `deleted_at timestamptz NULL`. Never `is_deleted boolean` (loses _when_, and `NULL` indexes are cheap: partial indexes `WHERE deleted_at IS NULL`) |
| Money       | `numeric(14,2)` + explicit `currency char(3)`. Never float.                                                                                        |
| Quantities  | `numeric(14,3)` (0.5 tablet is real)                                                                                                               |
| Timestamps  | `timestamptz` always, stored UTC; `branches.timezone` for display                                                                                  |
| Enums       | Postgres `ENUM` for closed sets (`appointment_status`); lookup tables for anything a tenant may extend (specialties, symptoms)                     |
| Naming      | `snake_case`, plural tables, `<singular>_id` FKs                                                                                                   |
| Uniqueness  | Always tenant-qualified: `UNIQUE (organization_id, code)`, never bare `code`                                                                       |
| Documents   | Metadata in `files`; binaries in object storage. Domain tables link to `files.id`.                                                                 |

Schemas (namespaces): `platform`, `iam`, `org`, `patient`, `clinical`, `lab`, `pharmacy`, `inventory`, `billing`, `ops`.

---

## 3. ERD — Platform, tenancy & subscriptions

```mermaid
erDiagram
  ORGANIZATIONS {
    uuid id PK
    string slug UK "subdomain: alpha -> alpha.xyz.com"
    string legal_name
    string display_name
    string org_type "CLINIC | HOSPITAL | CHAIN | LAB"
    string status "PENDING|ACTIVE|SUSPENDED|CANCELLED"
    char currency "ISO-4217"
    string timezone
    string country_code
    uuid owner_user_id FK
    timestamptz onboarded_at
    timestamptz deleted_at
  }
  ORGANIZATION_DOMAINS {
    uuid id PK
    uuid organization_id FK
    string domain UK "alpha.xyz.com or clinic.alpha.com"
    boolean is_primary
    timestamptz verified_at
  }
  BRANCHES {
    uuid id PK
    uuid organization_id FK
    string code "UK per org"
    string name
    string branch_type "CLINIC|HOSPITAL|LAB|PHARMACY"
    string timezone
    string phone
    string email
    string address_line1
    string city
    string state
    string pincode
    boolean is_primary
    string status
    timestamptz deleted_at
  }
  BRANCH_OPERATING_HOURS {
    uuid id PK
    uuid branch_id FK
    smallint day_of_week "0-6"
    time opens_at
    time closes_at
    boolean is_closed
    smallint slot_minutes
  }
  BRANCH_CLOSURES {
    uuid id PK
    uuid branch_id FK
    date closure_date
    string reason
  }
  PLANS {
    uuid id PK
    string code UK
    string name
    smallint trial_days
    boolean is_public
    int sort_order
  }
  PLAN_PRICES {
    uuid id PK
    uuid plan_id FK
    char currency
    string billing_interval "MONTH|YEAR"
    numeric amount
    boolean is_active
  }
  PLAN_FEATURES {
    uuid id PK
    uuid plan_id FK
    string feature_key "max_branches|max_users|pharmacy_module"
    string value_type "INT|BOOL"
    int int_value
    boolean bool_value
  }
  SUBSCRIPTIONS {
    uuid id PK
    uuid organization_id FK
    uuid plan_id FK
    uuid plan_price_id FK
    string status "TRIALING|ACTIVE|PAST_DUE|CANCELED|EXPIRED"
    timestamptz trial_ends_at
    timestamptz current_period_start
    timestamptz current_period_end
    timestamptz cancel_at
    timestamptz canceled_at
    int seat_quantity
    string gateway_ref
  }
  SUBSCRIPTION_FEATURE_OVERRIDES {
    uuid id PK
    uuid subscription_id FK
    string feature_key
    int int_value
    boolean bool_value
    string reason
  }
  SUBSCRIPTION_INVOICES {
    uuid id PK
    uuid organization_id FK
    uuid subscription_id FK
    string invoice_number UK
    date period_start
    date period_end
    numeric subtotal
    numeric tax_amount
    numeric total
    string status "DRAFT|OPEN|PAID|VOID|UNCOLLECTIBLE"
    date due_date
  }
  SUBSCRIPTION_INVOICE_LINES {
    uuid id PK
    uuid subscription_invoice_id FK
    string description
    numeric quantity
    numeric unit_amount
    numeric line_total
  }
  SUBSCRIPTION_PAYMENTS {
    uuid id PK
    uuid subscription_invoice_id FK
    numeric amount
    string method
    string gateway
    string gateway_payment_id
    string status
    timestamptz paid_at
  }
  USAGE_COUNTERS {
    uuid id PK
    uuid organization_id FK
    string feature_key
    date period_start
    numeric used_value
  }

  ORGANIZATIONS ||--o{ ORGANIZATION_DOMAINS : "reachable at"
  ORGANIZATIONS ||--o{ BRANCHES : "operates"
  BRANCHES ||--o{ BRANCH_OPERATING_HOURS : "opens"
  BRANCHES ||--o{ BRANCH_CLOSURES : "closed on"
  PLANS ||--o{ PLAN_PRICES : "priced as"
  PLANS ||--o{ PLAN_FEATURES : "grants"
  PLANS ||--o{ SUBSCRIPTIONS : "subscribed as"
  PLAN_PRICES ||--o{ SUBSCRIPTIONS : "billed at"
  ORGANIZATIONS ||--o{ SUBSCRIPTIONS : "holds"
  SUBSCRIPTIONS ||--o{ SUBSCRIPTION_FEATURE_OVERRIDES : "overridden by"
  SUBSCRIPTIONS ||--o{ SUBSCRIPTION_INVOICES : "billed via"
  SUBSCRIPTION_INVOICES ||--o{ SUBSCRIPTION_INVOICE_LINES : "lists"
  SUBSCRIPTION_INVOICES ||--o{ SUBSCRIPTION_PAYMENTS : "settled by"
  ORGANIZATIONS ||--o{ USAGE_COUNTERS : "consumes"
```

**Entitlement check** is one resolution order: `subscription_feature_overrides` → `plan_features` → hard default. `usage_counters` enforces `max_branches` / `max_users` at write time.

---

## 4. ERD — Identity, roles & permissions

```mermaid
erDiagram
  USERS {
    uuid id PK
    string email UK "global"
    string phone UK "global"
    string password_hash
    string full_name
    string avatar_file_id FK
    string status "INVITED|ACTIVE|SUSPENDED|LOCKED"
    boolean is_platform_admin "seeded super admin"
    boolean mfa_enabled
    string mfa_secret
    timestamptz email_verified_at
    timestamptz phone_verified_at
    timestamptz last_login_at
    timestamptz deleted_at
  }
  USER_IDENTITIES {
    uuid id PK
    uuid user_id FK
    string provider "GOOGLE|MICROSOFT|SAML"
    string provider_uid UK "unique with provider"
  }
  SESSIONS {
    uuid id PK
    uuid user_id FK
    uuid active_organization_id FK "branch switching lives here"
    uuid active_branch_id FK
    uuid impersonated_by_user_id FK "super-admin drill-down"
    string refresh_token_hash
    inet ip_address
    string user_agent
    timestamptz expires_at
    timestamptz revoked_at
  }
  AUTH_TOKENS {
    uuid id PK
    uuid user_id FK
    string purpose "LOGIN_OTP|RESET|VERIFY_EMAIL|VERIFY_PHONE"
    string identifier "email or phone"
    string code_hash
    smallint attempts
    timestamptz expires_at
    timestamptz consumed_at
  }
  MEMBERSHIPS {
    uuid id PK
    uuid user_id FK
    uuid organization_id FK "UK with user_id"
    string status "INVITED|ACTIVE|SUSPENDED"
    uuid invited_by FK
    timestamptz joined_at
    timestamptz deleted_at
  }
  ROLES {
    uuid id PK
    uuid organization_id FK "NULL = system role"
    string code "UK with organization_id"
    string name
    string scope_level "PLATFORM|ORGANIZATION|BRANCH"
    boolean is_system "not editable by tenant"
    string description
  }
  PERMISSIONS {
    uuid id PK
    string code UK "appointment.create, pharmacy.stock.adjust"
    string module
    string action
    string description
  }
  ROLE_PERMISSIONS {
    uuid id PK
    uuid role_id FK
    uuid permission_id FK
  }
  MEMBERSHIP_ROLES {
    uuid id PK
    uuid membership_id FK
    uuid role_id FK
    uuid branch_id FK "NULL = every branch in the org"
    timestamptz valid_from
    timestamptz valid_to
  }
  MEMBERSHIP_PERMISSION_OVERRIDES {
    uuid id PK
    uuid membership_id FK
    uuid permission_id FK
    uuid branch_id FK "NULL = org-wide"
    string effect "GRANT|DENY"
    string reason
  }
  INVITATIONS {
    uuid id PK
    uuid organization_id FK
    string email
    uuid role_id FK
    string token UK
    uuid invited_by FK
    timestamptz expires_at
    timestamptz accepted_at
  }
  INVITATION_BRANCHES {
    uuid id PK
    uuid invitation_id FK
    uuid branch_id FK
  }
  STAFF_PROFILES {
    uuid id PK
    uuid membership_id FK,UK
    string employee_code
    string department
    date joined_on
    date relieved_on
  }

  USERS ||--o{ USER_IDENTITIES : "authenticates via"
  USERS ||--o{ SESSIONS : "opens"
  USERS ||--o{ AUTH_TOKENS : "verifies with"
  USERS ||--o{ MEMBERSHIPS : "belongs to org via"
  ORGANIZATIONS ||--o{ MEMBERSHIPS : "has members"
  ORGANIZATIONS ||--o{ ROLES : "defines custom"
  ROLES ||--o{ ROLE_PERMISSIONS : "grants"
  PERMISSIONS ||--o{ ROLE_PERMISSIONS : "granted by"
  MEMBERSHIPS ||--o{ MEMBERSHIP_ROLES : "assigned"
  ROLES ||--o{ MEMBERSHIP_ROLES : "assigned as"
  BRANCHES ||--o{ MEMBERSHIP_ROLES : "scoped to"
  MEMBERSHIPS ||--o{ MEMBERSHIP_PERMISSION_OVERRIDES : "adjusted by"
  PERMISSIONS ||--o{ MEMBERSHIP_PERMISSION_OVERRIDES : "adjusted"
  MEMBERSHIPS ||--o| STAFF_PROFILES : "employs"
  ORGANIZATIONS ||--o{ INVITATIONS : "sends"
  INVITATIONS ||--o{ INVITATION_BRANCHES : "for branches"
  ORGANIZATIONS ||--o{ BRANCHES : "operates"
```

**Effective permission** for `(user, org, branch, permission)`:

```
DENY override           → denied
GRANT override          → allowed
role_permissions where membership_role.branch_id IN (branch, NULL) → allowed
otherwise               → denied
```

Seed system roles: `SUPER_ADMIN` (platform), `ORG_OWNER`, `ORG_ADMIN`, `BRANCH_ADMIN`, `DOCTOR`, `NURSE`, `RECEPTIONIST`, `FRONT_DESK`, `LAB_ASSISTANT`, `LAB_MANAGER`, `PHARMACIST`, `ACCOUNTANT`, `PATIENT`. Tenants clone these into custom roles — they never mutate `is_system` rows.

---

## 5. ERD — Doctors

A doctor is a `users` row with a `doctor_profiles` row. Practising at three branches = three `membership_roles`. Fees and schedules are **per branch**, which is why they are separate tables and not columns on the doctor.

```mermaid
erDiagram
  DOCTOR_PROFILES {
    uuid id PK
    uuid user_id FK,UK
    string registration_number "medical council"
    string registration_council
    date registration_valid_till
    smallint experience_years
    text bio
    uuid signature_file_id FK
    string status
  }
  SPECIALTIES {
    uuid id PK
    uuid parent_id FK "self-ref: sub-specialty"
    string code UK
    string name
    boolean is_active
  }
  QUALIFICATIONS {
    uuid id PK
    string code UK
    string name
  }
  DOCTOR_SPECIALTIES {
    uuid id PK
    uuid doctor_profile_id FK
    uuid specialty_id FK
    boolean is_primary
  }
  DOCTOR_QUALIFICATIONS {
    uuid id PK
    uuid doctor_profile_id FK
    uuid qualification_id FK
    string institute
    smallint year_of_completion
  }
  DOCTOR_BRANCH_SETTINGS {
    uuid id PK
    uuid doctor_profile_id FK
    uuid branch_id FK "UK with doctor"
    numeric consultation_fee
    numeric follow_up_fee
    smallint follow_up_free_days
    smallint slot_minutes
    boolean accepts_online_booking
    boolean is_active
  }
  DOCTOR_SCHEDULES {
    uuid id PK
    uuid doctor_profile_id FK
    uuid branch_id FK
    smallint day_of_week
    time start_time
    time end_time
    smallint slot_minutes
    smallint max_patients
    date valid_from
    date valid_to
  }
  DOCTOR_SCHEDULE_EXCEPTIONS {
    uuid id PK
    uuid doctor_profile_id FK
    uuid branch_id FK "NULL = all branches"
    string exception_type "LEAVE|EXTRA_SHIFT|BLOCK"
    timestamptz starts_at
    timestamptz ends_at
    string reason
    string status "REQUESTED|APPROVED|REJECTED"
  }
  DOCTOR_COMPENSATION_RULES {
    uuid id PK
    uuid doctor_profile_id FK
    uuid branch_id FK
    string basis "FIXED_MONTHLY|PER_CONSULTATION|PERCENT_OF_COLLECTION"
    numeric rate_value
    string applies_to "CONSULTATION|PROCEDURE|LAB|ALL"
    date effective_from
    date effective_to
  }
  DOCTOR_PAYOUTS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid doctor_profile_id FK
    date period_start
    date period_end
    numeric gross_amount
    numeric deductions
    numeric net_amount
    string status "DRAFT|APPROVED|PAID"
  }
  DOCTOR_PAYOUT_LINES {
    uuid id PK
    uuid doctor_payout_id FK
    uuid invoice_item_id FK
    numeric base_amount
    numeric earned_amount
  }

  USERS ||--o| DOCTOR_PROFILES : "is a doctor as"
  DOCTOR_PROFILES ||--o{ DOCTOR_SPECIALTIES : "specializes in"
  SPECIALTIES ||--o{ DOCTOR_SPECIALTIES : "held by"
  SPECIALTIES ||--o{ SPECIALTIES : "sub-specialty of"
  DOCTOR_PROFILES ||--o{ DOCTOR_QUALIFICATIONS : "holds"
  QUALIFICATIONS ||--o{ DOCTOR_QUALIFICATIONS : "awarded as"
  DOCTOR_PROFILES ||--o{ DOCTOR_BRANCH_SETTINGS : "charges at"
  BRANCHES ||--o{ DOCTOR_BRANCH_SETTINGS : "sets"
  DOCTOR_PROFILES ||--o{ DOCTOR_SCHEDULES : "available"
  BRANCHES ||--o{ DOCTOR_SCHEDULES : "hosts"
  DOCTOR_PROFILES ||--o{ DOCTOR_SCHEDULE_EXCEPTIONS : "unavailable"
  DOCTOR_PROFILES ||--o{ DOCTOR_COMPENSATION_RULES : "paid by"
  DOCTOR_PROFILES ||--o{ DOCTOR_PAYOUTS : "receives"
  DOCTOR_PAYOUTS ||--o{ DOCTOR_PAYOUT_LINES : "itemizes"
```

`specialties.parent_id` collapses the current `specialties` / `sub_specialties` / `specialization_map` triple into one self-referencing master.

---

## 6. ERD — Patients

Patient records are **organization-scoped**, not global — one org must not read another's patient list, and cross-org linkage is a consent problem, not a schema convenience. Within an org, a patient registers at each branch they visit via `patient_registrations`, which carries the branch-local MRN. Choosing a clinic in the UI = filtering on that registration.

```mermaid
erDiagram
  PATIENTS {
    uuid id PK
    uuid organization_id FK
    string uhid "UK with organization_id"
    uuid user_id FK "NULL until portal signup"
    string first_name
    string last_name
    date date_of_birth
    string gender
    string blood_group
    string phone
    string email
    string abha_number
    string national_id
    string marital_status
    string status
    timestamptz deleted_at
  }
  PATIENT_REGISTRATIONS {
    uuid id PK
    uuid organization_id FK
    uuid patient_id FK
    uuid branch_id FK "UK with patient_id"
    string mrn "branch-local record number"
    timestamptz registered_at
    uuid registered_by FK
    string status "ACTIVE|INACTIVE"
  }
  PATIENT_ADDRESSES {
    uuid id PK
    uuid patient_id FK
    string address_type "HOME|WORK|OTHER"
    string line1
    string line2
    string city
    string state
    string pincode
    string country_code
    boolean is_primary
  }
  PATIENT_CONTACTS {
    uuid id PK
    uuid patient_id FK
    string relation
    string name
    string phone
    boolean is_emergency
    boolean is_guardian
  }
  PATIENT_ALLERGIES {
    uuid id PK
    uuid patient_id FK
    string allergen_type "DRUG|FOOD|ENVIRONMENT"
    uuid medicine_id FK "NULL if non-drug"
    string allergen_text
    string severity "MILD|MODERATE|SEVERE"
    date noted_on
    uuid noted_by FK
  }
  PATIENT_CONDITIONS {
    uuid id PK
    uuid patient_id FK
    uuid diagnosis_id FK
    string status "ACTIVE|RESOLVED|CHRONIC"
    date onset_date
    date resolved_date
    text note
  }
  PATIENT_MEDICATIONS {
    uuid id PK
    uuid patient_id FK
    uuid medicine_id FK
    string medicine_text
    string dosage
    date started_on
    date stopped_on
    boolean is_ongoing
  }
  PATIENT_FAMILY_HISTORY {
    uuid id PK
    uuid patient_id FK
    string relation
    uuid diagnosis_id FK
    text note
  }
  PATIENT_INSURANCES {
    uuid id PK
    uuid patient_id FK
    string payer_name
    string policy_number
    string plan_name
    numeric coverage_amount
    date valid_from
    date valid_to
    boolean is_active
  }
  PATIENT_DOCUMENTS {
    uuid id PK
    uuid patient_id FK
    uuid file_id FK
    string document_type "ID_PROOF|REPORT|SCAN|CONSENT|OTHER"
    string title
    uuid uploaded_by FK
  }
  CONSENT_DEFINITIONS {
    uuid id PK
    uuid organization_id FK "NULL = platform-wide"
    string code
    string version
    string title
    text body
    boolean is_active
  }
  PATIENT_CONSENTS {
    uuid id PK
    uuid patient_id FK
    uuid consent_definition_id FK
    string channel "WEB|SMS|WHATSAPP|PAPER|IN_APP"
    boolean granted
    timestamptz granted_at
    timestamptz revoked_at
    inet ip_address
    uuid evidence_file_id FK
  }

  ORGANIZATIONS ||--o{ PATIENTS : "owns records of"
  PATIENTS ||--o{ PATIENT_REGISTRATIONS : "registered at"
  BRANCHES ||--o{ PATIENT_REGISTRATIONS : "registers"
  USERS ||--o| PATIENTS : "portal login for"
  PATIENTS ||--o{ PATIENT_ADDRESSES : "lives at"
  PATIENTS ||--o{ PATIENT_CONTACTS : "next of kin"
  PATIENTS ||--o{ PATIENT_ALLERGIES : "allergic to"
  PATIENTS ||--o{ PATIENT_CONDITIONS : "diagnosed with"
  PATIENTS ||--o{ PATIENT_MEDICATIONS : "takes"
  PATIENTS ||--o{ PATIENT_FAMILY_HISTORY : "family"
  PATIENTS ||--o{ PATIENT_INSURANCES : "covered by"
  PATIENTS ||--o{ PATIENT_DOCUMENTS : "has"
  PATIENTS ||--o{ PATIENT_CONSENTS : "consents"
  CONSENT_DEFINITIONS ||--o{ PATIENT_CONSENTS : "consented to"
```

The current single-row `patient_medical_history` with a free-text `allergies` column is replaced by four queryable tables — drug-allergy interaction checking is impossible against a text blob.

---

## 7. ERD — Scheduling & clinical encounters

`appointment` (a booking) and `encounter` (the clinical event) are separated. A walk-in has an encounter with no appointment; a no-show has an appointment with no encounter.

```mermaid
erDiagram
  APPOINTMENTS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid patient_id FK
    uuid doctor_profile_id FK
    string appointment_number "UK with branch"
    timestamptz scheduled_start
    timestamptz scheduled_end
    string visit_type "NEW|FOLLOW_UP|WALK_IN|TELECONSULT|PROCEDURE"
    string source "FRONT_DESK|ONLINE|PHONE|WHATSAPP"
    string status "BOOKED|CONFIRMED|CHECKED_IN|IN_PROGRESS|COMPLETED|CANCELLED|NO_SHOW"
    text reason
    timestamptz checked_in_at
    uuid cancelled_by FK
    text cancellation_reason
    timestamptz deleted_at
  }
  APPOINTMENT_STATUS_HISTORY {
    uuid id PK
    uuid appointment_id FK
    string from_status
    string to_status
    uuid changed_by FK
    timestamptz changed_at
    text note
  }
  QUEUE_TOKENS {
    uuid id PK
    uuid branch_id FK
    uuid doctor_profile_id FK
    date queue_date
    int token_number
    uuid appointment_id FK
    string status "WAITING|CALLED|SERVED|SKIPPED"
    timestamptz called_at
  }
  ENCOUNTERS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid patient_id FK
    uuid appointment_id FK "NULL for walk-in"
    uuid doctor_profile_id FK
    string encounter_type "OPD|IPD|EMERGENCY|TELECONSULT"
    timestamptz started_at
    timestamptz ended_at
    string status "OPEN|CLOSED|CANCELLED"
    text chief_complaint
  }
  VITALS {
    uuid id PK
    uuid encounter_id FK
    numeric temperature_c
    smallint pulse_bpm
    smallint bp_systolic
    smallint bp_diastolic
    smallint respiratory_rate
    numeric spo2
    numeric height_cm
    numeric weight_kg
    numeric bmi
    numeric blood_sugar
    uuid recorded_by FK
    timestamptz recorded_at
  }
  PRESCRIPTIONS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid encounter_id FK
    uuid patient_id FK
    uuid doctor_profile_id FK
    string prescription_number
    text advice
    date follow_up_date
    string status "DRAFT|FINALIZED|CANCELLED"
    timestamptz signed_at
    timestamptz deleted_at
  }
  SYMPTOMS {
    uuid id PK
    uuid organization_id FK "NULL = global master"
    string name
    string category
    boolean is_active
  }
  DIAGNOSES {
    uuid id PK
    uuid organization_id FK "NULL = global master"
    string icd10_code
    string name
    boolean is_active
  }
  PROCEDURES {
    uuid id PK
    uuid organization_id FK
    string code
    string name
    uuid specialty_id FK
    numeric default_price
    boolean is_active
  }
  PRESCRIPTION_SYMPTOMS {
    uuid id PK
    uuid prescription_id FK
    uuid symptom_id FK
    string duration
    string severity
    text note
  }
  PRESCRIPTION_DIAGNOSES {
    uuid id PK
    uuid prescription_id FK
    uuid diagnosis_id FK
    string diagnosis_type "PROVISIONAL|FINAL|DIFFERENTIAL"
    boolean is_primary
    text note
  }
  PRESCRIPTION_MEDICINES {
    uuid id PK
    uuid prescription_id FK
    uuid medicine_id FK "NULL if free-text"
    uuid generic_medicine_id FK
    string medicine_text
    string dosage
    string frequency_code "OD|BD|TDS|QID|SOS|HS"
    smallint duration_value
    string duration_unit "DAY|WEEK|MONTH"
    string route "ORAL|IV|IM|TOPICAL"
    string timing "BEFORE_FOOD|AFTER_FOOD"
    numeric quantity
    text instruction
  }
  PRESCRIPTION_PROCEDURES {
    uuid id PK
    uuid prescription_id FK
    uuid procedure_id FK
    date planned_date
    string status
    text note
  }
  PRESCRIPTION_FILES {
    uuid id PK
    uuid prescription_id FK
    uuid file_id FK
    string purpose "SCAN|PHOTO|SIGNED_PDF"
  }
  CLINICAL_FORM_TEMPLATES {
    uuid id PK
    uuid organization_id FK "NULL = platform template"
    uuid specialty_id FK
    string code "DENTAL_CHART|TRICHOLOGY|DERMATOLOGY"
    smallint version "UK with code"
    jsonb schema "field definitions"
    boolean is_active
  }
  CLINICAL_FORM_SUBMISSIONS {
    uuid id PK
    uuid encounter_id FK
    uuid clinical_form_template_id FK
    jsonb data "conforms to template schema"
    uuid submitted_by FK
    timestamptz submitted_at
  }
  DENTAL_CHART_ENTRIES {
    uuid id PK
    uuid encounter_id FK
    uuid patient_id FK
    smallint tooth_number "FDI notation"
    string surface "M|D|O|B|L"
    uuid condition_id FK
    uuid procedure_id FK
    string status "OBSERVED|PLANNED|COMPLETED"
    text note
  }

  BRANCHES ||--o{ APPOINTMENTS : "hosts"
  PATIENTS ||--o{ APPOINTMENTS : "books"
  DOCTOR_PROFILES ||--o{ APPOINTMENTS : "attends"
  APPOINTMENTS ||--o{ APPOINTMENT_STATUS_HISTORY : "transitions"
  APPOINTMENTS ||--o| QUEUE_TOKENS : "queued as"
  APPOINTMENTS ||--o| ENCOUNTERS : "realized as"
  PATIENTS ||--o{ ENCOUNTERS : "attends"
  DOCTOR_PROFILES ||--o{ ENCOUNTERS : "conducts"
  ENCOUNTERS ||--o{ VITALS : "records"
  ENCOUNTERS ||--o{ PRESCRIPTIONS : "produces"
  PRESCRIPTIONS ||--o{ PRESCRIPTION_SYMPTOMS : "notes"
  SYMPTOMS ||--o{ PRESCRIPTION_SYMPTOMS : "noted as"
  PRESCRIPTIONS ||--o{ PRESCRIPTION_DIAGNOSES : "concludes"
  DIAGNOSES ||--o{ PRESCRIPTION_DIAGNOSES : "concluded as"
  PRESCRIPTIONS ||--o{ PRESCRIPTION_MEDICINES : "prescribes"
  PRESCRIPTIONS ||--o{ PRESCRIPTION_PROCEDURES : "plans"
  PROCEDURES ||--o{ PRESCRIPTION_PROCEDURES : "planned as"
  PRESCRIPTIONS ||--o{ PRESCRIPTION_FILES : "attaches"
  ENCOUNTERS ||--o{ CLINICAL_FORM_SUBMISSIONS : "captures"
  CLINICAL_FORM_TEMPLATES ||--o{ CLINICAL_FORM_SUBMISSIONS : "structures"
  ENCOUNTERS ||--o{ DENTAL_CHART_ENTRIES : "charts"
  PATIENTS ||--o{ DENTAL_CHART_ENTRIES : "tooth history"
```

Adding an ophthalmology module later = inserting one `clinical_form_templates` row. No DDL. That is the extension point that keeps this schema stable.

---

## 8. ERD — Laboratory

```mermaid
erDiagram
  LABS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK "NULL = org-wide lab"
    string name
    string lab_type "IN_HOUSE|EXTERNAL|REFERRAL"
    string contact_phone
    boolean is_active
  }
  LAB_TESTS {
    uuid id PK
    uuid organization_id FK "NULL = global master"
    string code "LOINC where available"
    string name
    string category
    string sample_type "BLOOD|URINE|SWAB|TISSUE"
    smallint tat_hours "turnaround"
    boolean is_panel
    boolean is_active
  }
  LAB_TEST_PARAMETERS {
    uuid id PK
    uuid lab_test_id FK
    string name "Hemoglobin"
    string unit "g/dL"
    string result_type "NUMERIC|TEXT|ENUM"
    numeric ref_low
    numeric ref_high
    string ref_text
    string gender_applicability
    smallint age_min_years
    smallint age_max_years
    int display_order
  }
  LAB_PANEL_ITEMS {
    uuid id PK
    uuid panel_test_id FK
    uuid member_test_id FK
  }
  LAB_TEST_PRICES {
    uuid id PK
    uuid lab_id FK
    uuid lab_test_id FK "UK with lab_id"
    numeric price
    date effective_from
    boolean is_active
  }
  LAB_ORDERS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid patient_id FK
    uuid encounter_id FK
    uuid prescription_id FK
    uuid lab_id FK
    uuid ordered_by FK
    string order_number
    string priority "ROUTINE|URGENT|STAT"
    string status "ORDERED|SAMPLE_COLLECTED|IN_PROGRESS|RESULT_READY|VERIFIED|RELEASED|CANCELLED"
    timestamptz ordered_at
    timestamptz expected_at
  }
  LAB_ORDER_ITEMS {
    uuid id PK
    uuid lab_order_id FK
    uuid lab_test_id FK
    uuid parent_item_id FK "panel expansion"
    numeric price
    string status
  }
  LAB_SAMPLES {
    uuid id PK
    uuid lab_order_id FK
    string barcode UK
    string sample_type
    uuid collected_by FK
    timestamptz collected_at
    timestamptz received_at
    string status "PENDING|COLLECTED|RECEIVED|REJECTED"
    text rejection_reason
  }
  LAB_RESULTS {
    uuid id PK
    uuid lab_order_item_id FK
    uuid lab_test_parameter_id FK
    string value_text
    numeric value_numeric
    string unit
    string ref_range_text
    string abnormal_flag "NORMAL|HIGH|LOW|CRITICAL"
    uuid entered_by FK
    uuid verified_by FK
    timestamptz verified_at
    text remark
  }
  LAB_REPORTS {
    uuid id PK
    uuid lab_order_id FK
    uuid file_id FK
    smallint version
    uuid released_by FK
    timestamptz released_at
    boolean shared_with_patient
  }

  ORGANIZATIONS ||--o{ LABS : "operates"
  BRANCHES ||--o{ LABS : "hosts"
  LAB_TESTS ||--o{ LAB_TEST_PARAMETERS : "reports"
  LAB_TESTS ||--o{ LAB_PANEL_ITEMS : "panel contains"
  LABS ||--o{ LAB_TEST_PRICES : "prices"
  LAB_TESTS ||--o{ LAB_TEST_PRICES : "priced as"
  PATIENTS ||--o{ LAB_ORDERS : "undergoes"
  ENCOUNTERS ||--o{ LAB_ORDERS : "orders"
  PRESCRIPTIONS ||--o{ LAB_ORDERS : "requests"
  LABS ||--o{ LAB_ORDERS : "performs"
  LAB_ORDERS ||--o{ LAB_ORDER_ITEMS : "lists"
  LAB_TESTS ||--o{ LAB_ORDER_ITEMS : "ordered as"
  LAB_ORDERS ||--o{ LAB_SAMPLES : "collects"
  LAB_ORDER_ITEMS ||--o{ LAB_RESULTS : "yields"
  LAB_TEST_PARAMETERS ||--o{ LAB_RESULTS : "measured as"
  LAB_ORDERS ||--o{ LAB_REPORTS : "released as"
```

The current schema stores a lab report as a single URL with no parameters — a CBC has 20+ measured values. `lab_test_parameters` + `lab_results` makes trending a patient's hemoglobin over two years a query instead of a PDF hunt.

---

## 9. ERD — Pharmacy catalogue & procurement

```mermaid
erDiagram
  GENERIC_MEDICINES {
    uuid id PK
    string name UK
    string therapeutic_class
    string atc_code
    boolean is_active
  }
  DOSAGE_FORMS {
    uuid id PK
    string code UK
    string name "Tablet|Syrup|Injection"
  }
  UNITS_OF_MEASURE {
    uuid id PK
    string code UK
    string name
    string symbol
  }
  MANUFACTURERS {
    uuid id PK
    uuid organization_id FK "NULL = global master"
    string name
    string license_number
    string status
  }
  HSN_CODES {
    uuid id PK
    string hsn_code UK
    string description
  }
  TAX_RATES {
    uuid id PK
    uuid hsn_code_id FK
    numeric cgst_percent
    numeric sgst_percent
    numeric igst_percent
    numeric cess_percent
    date effective_from
    date effective_to
  }
  MEDICINE_CATEGORIES {
    uuid id PK
    uuid organization_id FK
    string name
    uuid parent_id FK
  }
  MEDICINES {
    uuid id PK
    uuid organization_id FK
    uuid generic_medicine_id FK
    uuid dosage_form_id FK
    uuid manufacturer_id FK
    uuid hsn_code_id FK
    uuid base_unit_id FK
    string brand_name
    string strength "500 mg"
    string drug_schedule "H|H1|X|OTC"
    boolean requires_prescription
    boolean is_narcotic
    string status
    timestamptz deleted_at
  }
  MEDICINE_CATEGORY_MAP {
    uuid id PK
    uuid medicine_id FK
    uuid medicine_category_id FK
  }
  MEDICINE_PACKS {
    uuid id PK
    uuid medicine_id FK
    uuid pack_unit_id FK
    numeric quantity_per_pack
    numeric mrp
    numeric purchase_price
    boolean is_default
  }
  SUPPLIERS {
    uuid id PK
    uuid organization_id FK
    string code "UK with organization_id"
    string name
    string gst_number
    string drug_license_number
    string contact_person
    string phone
    string email
    string address_line1
    string city
    smallint credit_days
    string status
  }
  PURCHASE_ORDERS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid supplier_id FK
    string po_number "UK with branch"
    date order_date
    date expected_date
    string status "DRAFT|SENT|PARTIALLY_RECEIVED|RECEIVED|CANCELLED"
    numeric subtotal
    numeric tax_amount
    numeric total_amount
    uuid created_by FK
  }
  PURCHASE_ORDER_ITEMS {
    uuid id PK
    uuid purchase_order_id FK
    uuid medicine_id FK
    uuid pack_id FK
    numeric quantity_ordered
    numeric quantity_received
    numeric purchase_price
    numeric tax_percent
    numeric line_total
  }
  GOODS_RECEIPTS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid purchase_order_id FK "NULL = direct purchase"
    uuid supplier_id FK
    string grn_number
    string supplier_invoice_number
    date supplier_invoice_date
    timestamptz received_at
    uuid received_by FK
    numeric total_amount
    string status
  }
  GOODS_RECEIPT_ITEMS {
    uuid id PK
    uuid goods_receipt_id FK
    uuid purchase_order_item_id FK
    uuid medicine_id FK
    uuid medicine_batch_id FK "batch created on receipt"
    numeric quantity_received
    numeric free_quantity
    numeric purchase_price
    numeric mrp
    numeric tax_percent
    numeric line_total
  }
  PURCHASE_RETURNS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid supplier_id FK
    uuid goods_receipt_id FK
    string return_number
    string reason "EXPIRED|DAMAGED|WRONG_ITEM"
    numeric total_amount
    string status
    timestamptz returned_at
  }
  PURCHASE_RETURN_ITEMS {
    uuid id PK
    uuid purchase_return_id FK
    uuid medicine_id FK
    uuid medicine_batch_id FK
    numeric quantity
    numeric unit_price
    numeric line_total
  }

  GENERIC_MEDICINES ||--o{ MEDICINES : "branded as"
  DOSAGE_FORMS ||--o{ MEDICINES : "form of"
  MANUFACTURERS ||--o{ MEDICINES : "manufactures"
  HSN_CODES ||--o{ MEDICINES : "classified as"
  HSN_CODES ||--o{ TAX_RATES : "taxed at"
  UNITS_OF_MEASURE ||--o{ MEDICINES : "measured in"
  MEDICINES ||--o{ MEDICINE_PACKS : "packed as"
  UNITS_OF_MEASURE ||--o{ MEDICINE_PACKS : "pack unit"
  MEDICINES ||--o{ MEDICINE_CATEGORY_MAP : "categorized"
  MEDICINE_CATEGORIES ||--o{ MEDICINE_CATEGORY_MAP : "groups"
  MEDICINE_CATEGORIES ||--o{ MEDICINE_CATEGORIES : "parent of"
  ORGANIZATIONS ||--o{ SUPPLIERS : "buys from"
  SUPPLIERS ||--o{ PURCHASE_ORDERS : "receives"
  BRANCHES ||--o{ PURCHASE_ORDERS : "raises"
  PURCHASE_ORDERS ||--o{ PURCHASE_ORDER_ITEMS : "lists"
  MEDICINES ||--o{ PURCHASE_ORDER_ITEMS : "ordered as"
  PURCHASE_ORDERS ||--o{ GOODS_RECEIPTS : "fulfilled by"
  GOODS_RECEIPTS ||--o{ GOODS_RECEIPT_ITEMS : "lists"
  PURCHASE_ORDER_ITEMS ||--o{ GOODS_RECEIPT_ITEMS : "received against"
  GOODS_RECEIPTS ||--o{ PURCHASE_RETURNS : "returned via"
  PURCHASE_RETURNS ||--o{ PURCHASE_RETURN_ITEMS : "lists"
```

`medicines` is **one** master (the current `care.medicines` legacy table is dropped). `tax_rates` is date-versioned because GST slabs change and historical invoices must reprint correctly.

---

## 10. ERD — Inventory & dispensing

```mermaid
erDiagram
  STORAGE_LOCATIONS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    string code "UK with branch"
    string name
    string rack
    string shelf
    string storage_condition "ROOM|COLD_2_8|FROZEN"
    boolean is_active
  }
  MEDICINE_BATCHES {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid medicine_id FK
    string batch_number "UK with branch+medicine"
    date manufacture_date
    date expiry_date
    numeric mrp
    numeric purchase_price
    uuid supplier_id FK
    uuid storage_location_id FK
    numeric quantity_received
    string status "ACTIVE|QUARANTINE|EXPIRED|RECALLED"
  }
  STOCK_BALANCES {
    uuid id PK
    uuid branch_id FK
    uuid medicine_id FK
    uuid medicine_batch_id FK "UK: branch+medicine+batch"
    numeric quantity_on_hand
    numeric quantity_reserved
    timestamptz last_movement_at
  }
  STOCK_LEDGER {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid medicine_id FK
    uuid medicine_batch_id FK
    string movement_type "PURCHASE|SALE|RETURN_IN|RETURN_OUT|ADJUSTMENT|TRANSFER_IN|TRANSFER_OUT|EXPIRY|CONSUMPTION"
    numeric quantity_in
    numeric quantity_out
    numeric balance_after
    string reference_type "GOODS_RECEIPT|DISPENSE|ADJUSTMENT|TRANSFER|RETURN"
    uuid reference_id "typed by reference_type"
    uuid performed_by FK
    timestamptz occurred_at
    text note
  }
  STOCK_ADJUSTMENTS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    string adjustment_number
    string reason "DAMAGE|EXPIRY|PHYSICAL_COUNT|THEFT|CORRECTION"
    uuid approved_by FK
    string status "DRAFT|APPROVED|REJECTED"
    timestamptz adjusted_at
  }
  STOCK_ADJUSTMENT_ITEMS {
    uuid id PK
    uuid stock_adjustment_id FK
    uuid medicine_id FK
    uuid medicine_batch_id FK
    numeric system_quantity
    numeric counted_quantity
    numeric difference
    text note
  }
  STOCK_TRANSFERS {
    uuid id PK
    uuid organization_id FK
    uuid from_branch_id FK
    uuid to_branch_id FK
    string transfer_number
    string status "REQUESTED|APPROVED|DISPATCHED|RECEIVED|CANCELLED"
    uuid requested_by FK
    uuid approved_by FK
    timestamptz dispatched_at
    timestamptz received_at
  }
  STOCK_TRANSFER_ITEMS {
    uuid id PK
    uuid stock_transfer_id FK
    uuid medicine_id FK
    uuid medicine_batch_id FK
    numeric quantity_sent
    numeric quantity_received
  }
  REORDER_RULES {
    uuid id PK
    uuid branch_id FK
    uuid medicine_id FK "UK with branch"
    numeric minimum_quantity
    numeric reorder_quantity
    uuid preferred_supplier_id FK
    boolean alert_enabled
  }
  DISPENSES {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid prescription_id FK "NULL for OTC sale"
    uuid patient_id FK "NULL for counter sale"
    string dispense_number
    uuid dispensed_by FK
    timestamptz dispensed_at
    string status "DRAFT|COMPLETED|CANCELLED|RETURNED"
  }
  DISPENSE_ITEMS {
    uuid id PK
    uuid dispense_id FK
    uuid prescription_medicine_id FK
    uuid medicine_id FK
    uuid medicine_batch_id FK
    numeric quantity
    numeric mrp
    numeric discount_amount
    numeric tax_percent
    numeric tax_amount
    numeric line_total
  }
  DISPENSE_RETURNS {
    uuid id PK
    uuid dispense_id FK
    string return_number
    string reason
    numeric refund_amount
    uuid processed_by FK
    timestamptz returned_at
  }
  DISPENSE_RETURN_ITEMS {
    uuid id PK
    uuid dispense_return_id FK
    uuid dispense_item_id FK
    numeric quantity
    numeric refund_amount
  }

  BRANCHES ||--o{ STORAGE_LOCATIONS : "stores at"
  MEDICINES ||--o{ MEDICINE_BATCHES : "batched as"
  BRANCHES ||--o{ MEDICINE_BATCHES : "holds"
  STORAGE_LOCATIONS ||--o{ MEDICINE_BATCHES : "located in"
  SUPPLIERS ||--o{ MEDICINE_BATCHES : "supplied"
  MEDICINE_BATCHES ||--|| STOCK_BALANCES : "current level"
  MEDICINE_BATCHES ||--o{ STOCK_LEDGER : "movements of"
  STOCK_ADJUSTMENTS ||--o{ STOCK_ADJUSTMENT_ITEMS : "lists"
  STOCK_TRANSFERS ||--o{ STOCK_TRANSFER_ITEMS : "lists"
  BRANCHES ||--o{ REORDER_RULES : "reorders at"
  MEDICINES ||--o{ REORDER_RULES : "governed by"
  PRESCRIPTIONS ||--o{ DISPENSES : "fulfilled by"
  PATIENTS ||--o{ DISPENSES : "receives"
  DISPENSES ||--o{ DISPENSE_ITEMS : "lists"
  MEDICINE_BATCHES ||--o{ DISPENSE_ITEMS : "issued from"
  PRESCRIPTION_MEDICINES ||--o{ DISPENSE_ITEMS : "dispensed against"
  DISPENSES ||--o{ DISPENSE_RETURNS : "returned via"
  DISPENSE_RETURNS ||--o{ DISPENSE_RETURN_ITEMS : "lists"
  GOODS_RECEIPT_ITEMS ||--|| MEDICINE_BATCHES : "creates"
```

Three things the current schema lacks entirely, all of which cause real money loss:

- **`stock_balances`** — a materialized current level per batch. Without it, "what's in stock" is a full ledger scan. Maintained by trigger on `stock_ledger` insert, inside the same transaction.
- **`stock_ledger.balance_after`** — makes the ledger auditable and self-verifying.
- **Expiry management** — driven off `medicine_batches.expiry_date` with a partial index `WHERE status='ACTIVE' AND expiry_date <= now() + interval '90 days'`. Batch selection at dispense is FEFO (first-expiry-first-out) against `stock_balances`.

`stock_ledger.reference_id` is the one deliberate polymorphic column in the design — it points at whichever document caused the movement. It is constrained by `CHECK` on `reference_type` and indexed on `(reference_type, reference_id)`, and it is _never_ joined for correctness (the ledger is self-contained), only for drill-down.

---

## 11. ERD — Billing & revenue

```mermaid
erDiagram
  BILLABLE_ITEMS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK "NULL = all branches"
    string code
    string name
    string item_type "CONSULTATION|PROCEDURE|LAB|PHARMACY|BED|OTHER"
    uuid reference_id "procedure_id / lab_test_id when applicable"
    numeric default_price
    string sac_hsn_code
    numeric tax_percent
    boolean is_active
  }
  INVOICES {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid patient_id FK
    string invoice_number "UK with branch+fy"
    date invoice_date
    string source_type "APPOINTMENT|ENCOUNTER|DISPENSE|LAB_ORDER|MANUAL"
    uuid appointment_id FK
    uuid encounter_id FK
    uuid dispense_id FK
    uuid lab_order_id FK
    uuid doctor_profile_id FK
    char currency
    numeric subtotal
    numeric discount_amount
    numeric taxable_amount
    numeric tax_amount
    numeric round_off
    numeric total_amount
    numeric paid_amount
    numeric balance_amount
    string status "DRAFT|ISSUED|PARTIALLY_PAID|PAID|CANCELLED|REFUNDED"
    uuid created_by FK
    timestamptz deleted_at
  }
  INVOICE_ITEMS {
    uuid id PK
    uuid invoice_id FK
    uuid billable_item_id FK
    string item_type
    uuid reference_id "medicine_id | lab_test_id | procedure_id"
    uuid medicine_batch_id FK
    string description
    numeric quantity
    numeric unit_price
    numeric discount_percent
    numeric discount_amount
    numeric taxable_amount
    numeric tax_percent
    numeric tax_amount
    numeric line_total
    uuid doctor_profile_id FK "for revenue attribution"
  }
  INVOICE_TAX_LINES {
    uuid id PK
    uuid invoice_id FK
    string tax_type "CGST|SGST|IGST|CESS"
    numeric rate_percent
    numeric taxable_amount
    numeric tax_amount
  }
  PAYMENTS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid patient_id FK
    string payment_number
    numeric amount
    string method "CASH|CARD|UPI|NETBANKING|INSURANCE|WALLET"
    string reference_number
    string gateway
    string gateway_payment_id
    string status "PENDING|SUCCESS|FAILED|REFUNDED"
    uuid received_by FK
    timestamptz received_at
  }
  PAYMENT_ALLOCATIONS {
    uuid id PK
    uuid payment_id FK
    uuid invoice_id FK
    numeric allocated_amount
  }
  CREDIT_NOTES {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid invoice_id FK
    string credit_note_number
    string reason
    numeric total_amount
    string status
    uuid approved_by FK
    timestamptz issued_at
  }
  CREDIT_NOTE_ITEMS {
    uuid id PK
    uuid credit_note_id FK
    uuid invoice_item_id FK
    numeric quantity
    numeric amount
  }
  REFUNDS {
    uuid id PK
    uuid credit_note_id FK
    uuid payment_id FK
    numeric amount
    string method
    string status
    uuid processed_by FK
    timestamptz refunded_at
  }
  PATIENT_LEDGER {
    uuid id PK
    uuid organization_id FK
    uuid patient_id FK
    string entry_type "INVOICE|PAYMENT|CREDIT_NOTE|REFUND|ADVANCE"
    uuid reference_id
    numeric debit
    numeric credit
    numeric balance_after
    timestamptz occurred_at
  }
  NUMBER_SEQUENCES {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    string sequence_type "INVOICE|APPOINTMENT|MRN|PO|GRN|LAB_ORDER"
    string financial_year
    string prefix
    bigint last_number
    smallint padding
  }

  PATIENTS ||--o{ INVOICES : "billed"
  BRANCHES ||--o{ INVOICES : "issues"
  APPOINTMENTS ||--o| INVOICES : "billed as"
  DISPENSES ||--o| INVOICES : "billed as"
  LAB_ORDERS ||--o| INVOICES : "billed as"
  INVOICES ||--o{ INVOICE_ITEMS : "lists"
  BILLABLE_ITEMS ||--o{ INVOICE_ITEMS : "charged as"
  INVOICES ||--o{ INVOICE_TAX_LINES : "taxed as"
  PAYMENTS ||--o{ PAYMENT_ALLOCATIONS : "applied to"
  INVOICES ||--o{ PAYMENT_ALLOCATIONS : "settled by"
  INVOICES ||--o{ CREDIT_NOTES : "credited by"
  CREDIT_NOTES ||--o{ CREDIT_NOTE_ITEMS : "lists"
  CREDIT_NOTES ||--o{ REFUNDS : "refunded via"
  PATIENTS ||--o{ PATIENT_LEDGER : "owes"
  INVOICE_ITEMS ||--o{ DOCTOR_PAYOUT_LINES : "earns"
  ORGANIZATIONS ||--o{ NUMBER_SEQUENCES : "numbers"
```

`payment_allocations` (rather than `payments.invoice_id`) supports the real cases: one payment covering three invoices, and advance payments applied later. `number_sequences` generalizes the current per-clinic invoice counter to every document type and adds financial-year reset — required for GST compliance.

---

## 12. ERD — Settings, notifications & audit

```mermaid
erDiagram
  SETTING_DEFINITIONS {
    uuid id PK
    string key UK "billing.invoice_prefix, appointment.slot_minutes"
    string module
    string data_type "STRING|INT|BOOL|JSON|DECIMAL"
    jsonb default_value
    jsonb allowed_scopes "[PLATFORM,ORGANIZATION,BRANCH,USER,PATIENT]"
    boolean is_tenant_editable
    string description
  }
  SETTING_VALUES {
    uuid id PK
    string setting_key FK
    string scope_type "PLATFORM|ORGANIZATION|BRANCH|USER|PATIENT|DOCTOR"
    uuid scope_id "UK: key+scope_type+scope_id"
    jsonb value
    uuid updated_by FK
    timestamptz updated_at
  }
  NOTIFICATION_TEMPLATES {
    uuid id PK
    uuid organization_id FK "NULL = platform default"
    string event_code "APPOINTMENT_BOOKED|LAB_REPORT_READY"
    string channel "EMAIL|SMS|WHATSAPP|PUSH|IN_APP"
    string locale
    string subject
    text body "handlebars template"
    string provider_template_id
    boolean is_active
  }
  NOTIFICATION_PREFERENCES {
    uuid id PK
    string scope_type "ORGANIZATION|BRANCH|USER|PATIENT"
    uuid scope_id
    string event_code
    string channel
    boolean enabled
  }
  NOTIFICATIONS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    string recipient_type "USER|PATIENT"
    uuid recipient_id
    string event_code
    string channel
    string destination "email/phone"
    jsonb payload
    string status "QUEUED|SENT|DELIVERED|READ|FAILED"
    smallint attempts
    text error_message
    timestamptz scheduled_at
    timestamptz sent_at
  }
  FILES {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    string storage_key UK
    string original_name
    string mime_type
    bigint size_bytes
    string checksum
    uuid uploaded_by FK
    timestamptz uploaded_at
    timestamptz deleted_at
  }
  AUDIT_LOGS {
    uuid id PK
    uuid organization_id FK
    uuid branch_id FK
    uuid actor_user_id FK
    uuid impersonated_by FK
    string action "CREATE|UPDATE|DELETE|LOGIN|EXPORT|SWITCH_BRANCH"
    string entity_type
    uuid entity_id
    jsonb before_data
    jsonb after_data
    inet ip_address
    string user_agent
    timestamptz occurred_at
  }
  DATA_ACCESS_LOGS {
    uuid id PK
    uuid organization_id FK
    uuid actor_user_id FK
    uuid patient_id FK
    string access_type "VIEW|PRINT|EXPORT|SHARE"
    string resource "PRESCRIPTION|LAB_REPORT|INVOICE"
    uuid resource_id
    timestamptz occurred_at
  }
  OUTBOX_EVENTS {
    uuid id PK
    uuid organization_id FK
    string event_type
    string aggregate_type
    uuid aggregate_id
    jsonb payload
    timestamptz published_at
    smallint attempts
  }

  SETTING_DEFINITIONS ||--o{ SETTING_VALUES : "instantiated as"
  ORGANIZATIONS ||--o{ NOTIFICATION_TEMPLATES : "customizes"
  NOTIFICATION_TEMPLATES ||--o{ NOTIFICATIONS : "renders"
  ORGANIZATIONS ||--o{ NOTIFICATIONS : "sends"
  ORGANIZATIONS ||--o{ FILES : "owns"
  ORGANIZATIONS ||--o{ AUDIT_LOGS : "audited"
  USERS ||--o{ AUDIT_LOGS : "acted"
  PATIENTS ||--o{ DATA_ACCESS_LOGS : "record accessed"
  ORGANIZATIONS ||--o{ OUTBOX_EVENTS : "emits"
```

**Settings resolution** — the granularity you asked for falls out of one lookup, most specific wins:

```
USER/PATIENT value → BRANCH value → ORGANIZATION value → PLATFORM value → definition default
```

Adding a new setting is an `INSERT` into `setting_definitions`. No migration, no new column, and the same mechanism serves clinic-level and doctor-level preferences.

`audit_logs` and `data_access_logs` should be `PARTITION BY RANGE (occurred_at)` monthly from day one — retrofitting partitioning onto a large table is painful.

---

## 13. Dashboard queries this schema makes cheap

| Dashboard tile               | Query shape                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Total doctors in clinic      | `membership_roles` ⋈ `roles` where `role.code='DOCTOR'` and `branch_id IN (branch, NULL)`                                   |
| Total patients in clinic     | `count(*) FROM patient_registrations WHERE branch_id = ?`                                                                   |
| Appointments (today / range) | `appointments` on `(branch_id, scheduled_start)` — covering index                                                           |
| Earnings so far              | `sum(total_amount)` / `sum(paid_amount)` FROM `invoices` WHERE `branch_id` — one table, because there is one invoice system |
| Revenue by doctor            | `invoice_items.doctor_profile_id` — attribution is on the line, not inferred                                                |
| Revenue by module            | `invoice_items.item_type` group-by                                                                                          |
| Stock value / expiring soon  | `stock_balances ⋈ medicine_batches` on `expiry_date`                                                                        |
| Pending lab reports          | `lab_orders` where `status IN ('ORDERED','IN_PROGRESS')`                                                                    |
| Outstanding dues             | `sum(balance_amount) FROM invoices WHERE status IN ('ISSUED','PARTIALLY_PAID')`                                             |

For an org-wide (all-branches) view the super admin or org admin simply widens `app.branch_scope`. Same queries, no code fork.

Roll-ups: a `daily_branch_metrics` summary table refreshed nightly (branch_id, metric_date, appointment counts by status, new patients, gross revenue, collections, dispense count, stock value). Dashboards read the summary; drill-downs hit the live tables.

---

## 14. Indexing baseline

```sql
-- every tenant table
CREATE INDEX ON <table> (organization_id, branch_id) WHERE deleted_at IS NULL;

-- hot paths
CREATE INDEX ON appointments (branch_id, scheduled_start DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON appointments (doctor_profile_id, scheduled_start);
CREATE INDEX ON appointments (patient_id, scheduled_start DESC);
CREATE UNIQUE INDEX ON patients (organization_id, uhid);
CREATE UNIQUE INDEX ON patient_registrations (patient_id, branch_id);
CREATE INDEX ON patients USING gin (
  (first_name || ' ' || last_name || ' ' || phone) gin_trgm_ops);  -- name/phone search
CREATE INDEX ON stock_ledger (branch_id, medicine_id, occurred_at DESC);
CREATE UNIQUE INDEX ON stock_balances (branch_id, medicine_id, medicine_batch_id);
CREATE INDEX ON medicine_batches (branch_id, expiry_date)
  WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX ON invoices (branch_id, invoice_number);
CREATE INDEX ON invoices (branch_id, invoice_date DESC, status);
CREATE INDEX ON membership_roles (membership_id, branch_id);
CREATE INDEX ON audit_logs (organization_id, entity_type, entity_id, occurred_at DESC);
```

Two exclusion constraints worth adding early (they prevent double-booking at the database level):

```sql
ALTER TABLE appointments ADD CONSTRAINT no_doctor_overlap
  EXCLUDE USING gist (
    doctor_profile_id WITH =,
    tstzrange(scheduled_start, scheduled_end) WITH &&
  ) WHERE (status NOT IN ('CANCELLED','NO_SHOW'));
```

---

## 15. What was deliberately left out, and why

| Not modeled                                | Reason                                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IPD / bed management, OT scheduling        | `encounters.encounter_type='IPD'` is the hook; the ward/bed/admission tables are a self-contained additive module. Say the word and I'll add them.                                                                   |
| Insurance claim lifecycle (TPA, pre-auth)  | `patient_insurances` captures the policy; claims adjudication is its own subsystem.                                                                                                                                  |
| ABDM / ABHA integration tables             | Deliberately kept to `patients.abha_number` + `patient_consents`. The current schema's four ABDM session tables are integration scratch state — that belongs in Redis, not Postgres.                                 |
| Per-tenant schemas or per-tenant databases | Shared schema + RLS scales to thousands of tenants without migration fan-out. Revisit only if a single tenant needs physical isolation for compliance; the `organization_id` column makes extraction possible later. |
| Physical `deleted` archival                | Soft delete + partitioned audit covers retention; add archival jobs when volume demands.                                                                                                                             |

---

## 16. Build order

1. `organizations`, `branches`, `users`, `memberships`, `roles`, `permissions`, `membership_roles` — plus RLS policies and the session GUC plumbing. **Nothing else starts until branch switching and permission checks work end to end.**
2. `plans`, `subscriptions`, entitlement resolution.
3. `patients`, `patient_registrations`, `appointments`, `encounters`.
4. `prescriptions` + masters + `clinical_form_templates`.
5. `billable_items`, `invoices`, `payments`, `number_sequences`.
6. Pharmacy catalogue → inventory → dispensing (this order; dispensing depends on batches).
7. Lab.
8. `setting_definitions`/`setting_values`, notifications, audit — cross-cutting, but seed `setting_definitions` from step 1.
9. `daily_branch_metrics` + dashboard.
