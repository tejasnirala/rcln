export * from './common.js';
/* ⚠️ BEFORE `auth.js`, WHICH IMPORTS `clinicProfileSummary` AND `clinicModule`
   FROM IT — the session carries the resolved profile so the shell can draw the
   right nav and the patient form the right default. That is also why the file
   imports nothing but `common.js`: anything it pulled in would have to come
   before it too, and a Zod module cycle fails at runtime rather than at lint.
   The wizard's own request/response shapes are `onboarding-wizard.js`, exported
   further down. */
export * from './onboarding.js';
export * from './auth.js';
export * from './tenancy.js';
export * from './marketing.js';
export * from './audit.js';
export * from './clinical-taxonomy.js';
export * from './clinical.js';
/* ⚠️ BEFORE `consultation.js` and `encounter-content.js`, both of which import
   from it — the first for the resolved chart on a section config, the second
   for the finding shapes on `encounterContent`. It imports from neither, and a
   Zod module cycle fails at runtime rather than at lint. */
export * from './visual-mapping.js';
export * from './consultation.js';
export * from './encounters.js';
export * from './encounter-content.js';
/* ⚠️ AFTER both `clinical.js` and `encounter-content.js` — it imports from each,
   and a Zod module cycle fails at runtime rather than at lint. See its header. */
export * from './visit-history.js';
export * from './doctors.js';
export * from './patients.js';
export * from './appointments.js';
export * from './billing.js';
export * from './invoices.js';
export * from './fees.js';
export * from './products.js';
export * from './inventory.js';
export * from './procurement.js';
export * from './regulatory.js';
export * from './pharmacy.js';
/* ⚠️ AFTER `invoices.js` and `products.js` — it imports the source-type and
   product-type enums from them, and a Zod module cycle fails at runtime rather
   than at lint. Same note `visit-history.js` carries. */
export * from './charging.js';
/* ⚠️ AFTER `inventory.js` and `common.js`, whose `positiveQuantity` and
   `calendarDate` it imports. It deliberately imports nothing from `charging.js`
   — consumption knows nothing about billability (PI-ADR-005) — so the order
   relative to that line is arbitrary and the placement is alphabetical drift,
   not a dependency. */
export * from './consumption.js';
/* ⚠️ AFTER `common.js` only. Recall imports nothing from inventory, pharmacy or
   consumption — it names lots and patients by id and answers in counts — so the
   placement carries no dependency, unlike the two notes above. */
export * from './recall.js';
/* ⚠️ AFTER `pharmacy.js` and `products.js`. It imports `dispenseRegulatorySummary`
   from the first and `countryCode`/`decimalString` from the second, and a Zod
   module cycle fails at runtime rather than at lint — the note `charging.js`
   carries, for the same reason. */
export * from './online-pharmacy.js';
export * from './tax.js';
export * from './locale.js';
/* ⚠️ AFTER `tenancy.js` (for `operatingHour`), `tax.js` (for
   `createClinicTaxRegistrationRequest`) and `locale.js` (for `TIME_FORMATS`) —
   it imports from all three. Its session-borne half is `onboarding.js`, which
   is exported before `auth.js` for the opposite reason. */
export * from './onboarding-wizard.js';
/* ⚠️ AFTER `products.js` and `common.js`, whose `decimalString` and
   `calendarDate` it imports. It deliberately imports nothing from the nine
   surfaces it REPORTS on — a report re-states a figure in its own shape rather
   than re-exporting the shape that wrote it, so `inventory.js` renaming a field
   is a compile error here rather than a silent change to a CSV column heading. */
export * from './reports.js';
