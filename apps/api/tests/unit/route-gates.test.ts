/**
 * The permission audit, as an assertion over the routers themselves (CE-8).
 *
 * ⚠️ THE BUG THIS EXISTS TO CATCH IS AN OMISSION, AND IT IS INVISIBLE EVERYWHERE
 *   ELSE. A route registered without `authorize(...)` typechecks, lints, returns
 *   200 to whoever is signed in, and reads in a diff exactly like the four
 *   gated routes above it. The clinical routers are also the place where the
 *   omission is most expensive: every response under `/encounters` is one named
 *   patient's clinical record, and `encounters.routes.ts` builds twenty-seven of
 *   them from a table in a loop, where one wrong entry looks like the other
 *   twenty-six.
 *
 * ⚠️ IT AUDITS THE STACK, NOT A LIST SOMEBODY MAINTAINS. Enumerating the routes
 *   in this file would mean a new route is absent from the test on the day it is
 *   added — which is the day it needs auditing. Everything below is derived from
 *   the router Express actually has.
 *
 * ⚠️ AND IT SAYS WHICH CODE, NOT MERELY "SOME CODE". Invariant 7 is a statement
 *   about WHICH permission gates WHICH act: reading a record is
 *   `clinical.encounter.read` and writing in it is `clinical.encounter.create`,
 *   held by DOCTOR alone. A write that shipped behind the read code would be
 *   gated, audited, and wrong.
 */
import { readdir } from 'node:fs/promises';
import type { IRouter, RequestHandler } from 'express';
import { PERMISSIONS } from '@rcln/permissions';
import { requiredPermissionsOf } from '../../src/middleware/auth.middleware.js';
import { disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import encounterRoutes from '../../src/routes/v1/encounters.routes.js';
import clinicalRoutes from '../../src/routes/v1/clinical.routes.js';
import consultationTemplateRoutes from '../../src/routes/v1/consultation-templates.routes.js';
import visualMapRoutes from '../../src/routes/v1/visual-maps.routes.js';
import pharmacyRoutes from '../../src/routes/v1/pharmacy.routes.js';
import onlineOrderRoutes from '../../src/routes/v1/online-pharmacy.routes.js';
import consumptionRoutes from '../../src/routes/v1/consumption.routes.js';
import { recallRoutes, traceabilityRoutes } from '../../src/routes/v1/recalls.routes.js';
import reportRoutes from '../../src/routes/v1/reports.routes.js';

/**
 * ⚠️ THIS SUITE TOUCHES NO DATABASE AND STILL HAS TO HANG UP.
 *
 *   It is the only unit suite that imports from `src/`, and importing a router
 *   pulls the whole service layer behind it — which opens a Redis connection at
 *   module load, whether or not anything uses it. Without this the assertions
 *   all pass in a second and the RUN never ends, which in a serial suite is
 *   indistinguishable from a hang somewhere else entirely.
 */
afterAll(async () => {
  await disconnectDb();
  await redis.quit();
});

interface Route {
  readonly method: string;
  readonly path: string;
  readonly permissions: readonly string[] | null;
}

/**
 * Every route on a router, with the codes its own `authorize` was built with.
 *
 * ⚠️ `null` MEANS UNGATED AND `[]` CANNOT HAPPEN — `authorize()` with no codes
 *   would be a gate that grants everything, and the distinction matters because
 *   the assertion below is about the difference.
 */
function routesOf(router: IRouter): Route[] {
  /* Express does not type its own stack; this is the shape it has. */
  const stack = (router as unknown as { stack: { route?: RouteLayer }[] }).stack;
  const routes: Route[] = [];

  for (const layer of stack) {
    const route = layer.route;
    if (route === undefined) continue;

    /*
     * ⚠️ EXACTLY ONE `authorize` PER ROUTE, NOT "THE FIRST ONE". Two gates on a
     *   route would leave the second unaudited by everything below, and two
     *   gates disagreeing about who may call something is not a thing to
     *   discover from a bug report.
     */
    const gates = route.stack
      .map((entry) => requiredPermissionsOf(entry.handle as RequestHandler))
      .filter((codes) => codes !== null);
    if (gates.length > 1) {
      throw new Error(`${route.path} has ${String(gates.length)} authorize() gates on it`);
    }
    const permissions = gates[0];

    for (const [method, enabled] of Object.entries(route.methods)) {
      if (enabled !== true) continue;
      routes.push({
        method: method.toUpperCase(),
        path: route.path,
        permissions: permissions ?? null,
      });
    }
  }

  return routes;
}

interface RouteLayer {
  path: string;
  methods: Record<string, boolean>;
  stack: { handle: unknown }[];
}

const ROUTERS: { name: string; router: IRouter }[] = [
  { name: 'encounters', router: encounterRoutes },
  { name: 'clinical', router: clinicalRoutes },
  { name: 'consultation-templates', router: consultationTemplateRoutes },
  { name: 'visual-maps', router: visualMapRoutes },
  /*
   * ⚠️ PHARMACY IS AUDITED HERE EVEN THOUGH IT AUTHORS NOTHING (PI-7), AND THAT
   *   IS THE POINT. It READS the clinical record — the queue, a prescription, a
   *   dispensing history — so it discloses exactly what the four above write, and
   *   an ungated route on it would be the same disclosure with none of the
   *   scrutiny. The case below it asserts the other half: that no route on this
   *   router carries an AUTHORING code (invariant 7).
   */
  { name: 'pharmacy', router: pharmacyRoutes },
  /*
   * ⚠️ ONLINE ORDERS ARE AUDITED FOR THE REASON PHARMACY IS, PLUS ONE OF THEIR
   *   OWN (PI-12). Every read discloses a named person's HOME ADDRESS beside the
   *   medicine going to it — a broader disclosure than the counter makes — and
   *   one route on this router IS a dispense. The case below asserts the split
   *   that matters: packing carries `pharmacy.dispense.create` and every other
   *   write carries an `online_order` code, so a clinic cannot hand somebody the
   *   authority to supply by giving them the desk that takes telephone orders.
   */
  { name: 'online-orders', router: onlineOrderRoutes },
  /*
   * ⚠️ CONSUMPTION IS AUDITED FOR THE REASON PHARMACY IS (PI-9), AND IT IS THE
   *   CLOSER CALL OF THE TWO. It is anchored to a consultation, it is reached
   *   from the consultation's own screen, and it names a patient beside a device
   *   serial — so it discloses what the four clinical routers write, while
   *   authoring none of it. The case below asserts the other half: no route on
   *   this router carries a `clinical.*` code.
   */
  { name: 'consumption', router: consumptionRoutes },
  /*
   * ⚠️ RECALL IS AUDITED HERE BECAUSE OF ONE ROUTE (PI-10). Most of this pair
   *   answers in lot numbers and counts and discloses nobody — but
   *   `GET /v1/traceability/affected` returns a page of NAMED PATIENTS with
   *   phone numbers, which is the broadest disclosure the platform serves and is
   *   served to a storekeeper. The cases below assert the other half: that the
   *   pair carries no `clinical.*` code, and that the one PHI route carries the
   *   patient code ON TOP OF the read code rather than instead of it.
   */
  { name: 'recalls', router: recallRoutes },
  { name: 'traceability', router: traceabilityRoutes },
  /*
   * ⚠️ REPORTS ARE AUDITED FOR THE REASON CONSUMPTION IS, AND IT IS THE CLOSEST
   *   CALL OF ALL OF THEM (PI-22). Two of the nine reports READ
   *   `clinical_consumptions`, whose `patient_id` is NOT NULL — so they open the
   *   most patient-bound table in the programme, and they are the one surface in
   *   it that returns nobody. The whole design rests on that grouping holding,
   *   and the case below is where "no report names a patient" stops being a
   *   sentence in a header and becomes an assertion.
   */
  { name: 'reports', router: reportRoutes },
];

/**
 * ⚠️ THE LIST ABOVE IS THE ONE THING IN THIS FILE THAT A HUMAN MAINTAINS, AND
 *   THEREFORE THE ONE THING THAT CAN GO STALE. A fifth clinical router added
 *   tomorrow would be absent from the audit on the day it needs auditing —
 *   exactly the omission class the rest of the suite exists to catch, one level
 *   up.
 *
 *   So the route directory is read from disk and compared against a manifest of
 *   every router in it: the four audited here, and every other one with a
 *   reason. A new `*.routes.ts` file fails this case until somebody classifies
 *   it, which is a thirty-second decision made by the person who knows the
 *   answer.
 */
const NOT_CLINICAL: string[] = [
  /* No tenant, no caller: registration, the marketing forms, the probe. */
  'public.routes.ts',
  'health.routes.ts',
  'auth.routes.ts',
  'webhooks.routes.ts',
  /* Its own console, behind `requirePlatformAdmin` rather than `authorize`. */
  'platform.routes.ts',
  /* Tenant surfaces, gated the same way — audited by their own suites. */
  'appointments.routes.ts',
  'audit.routes.ts',
  'billing.routes.ts',
  'branches.routes.ts',
  /*
   * ⚠️ CHARGING TOUCHES THE CLINICAL RECORD ONLY THROUGH A PRICE (PI-8), WHICH IS
   *   WHY IT IS HERE AND NOT IN `AUDITED_FILES`. A charge request names a patient
   *   and a medicine, so its READ is a disclosure and logs like one — but the
   *   router authors nothing clinical and carries no `clinical.*` code, which is
   *   the property that list exists to police. It is audited by
   *   `tests/integration/charging.test.ts` and by the charging isolation suite.
   */
  'charging.routes.ts',
  'clinical-taxonomy.routes.ts',
  'designations.routes.ts',
  'doctors.routes.ts',
  'fees.routes.ts',
  'index.ts',
  'inventory.routes.ts',
  'invitations.routes.ts',
  'invoices.routes.ts',
  'members.routes.ts',
  'organization.routes.ts',
  'patients.routes.ts',
  'procurement.routes.ts',
  'product-catalogue.routes.ts',
  'products.routes.ts',
  'regulatory.routes.ts',
  'roles.routes.ts',
  'tax.routes.ts',
];

const AUDITED_FILES: string[] = [
  'reports.routes.ts',
  'recalls.routes.ts',
  'pharmacy.routes.ts',
  'online-pharmacy.routes.ts',
  'consumption.routes.ts',
  'encounters.routes.ts',
  'clinical.routes.ts',
  'consultation-templates.routes.ts',
  'visual-maps.routes.ts',
];

describe('the audit knows about every router', () => {
  it('has classified every route file in v1', async () => {
    const directory = new URL('../../src/routes/v1/', import.meta.url);
    const files = (await readdir(directory)).filter((file) => file.endsWith('.ts'));

    const unclassified = files.filter(
      (file) => !AUDITED_FILES.includes(file) && !NOT_CLINICAL.includes(file)
    );

    expect(unclassified).toEqual([]);
    /* And the four above are really there, not four renamed files. */
    for (const file of AUDITED_FILES) expect(files).toContain(file);
  });
});

/**
 * ⚠️ A GATE ON A ROUTE THAT NOBODY AUTHENTICATED IS NOT A GATE. `authorize`
 *   reads `req.auth`, which `authenticate` populates and `requireAuth` insists
 *   on — so a route registered ABOVE the `router.use(...)` line would carry a
 *   permission code, pass every assertion below, and run for a caller with no
 *   token at all. The chain is the security model and its ORDER is the security
 *   model (see the header of `app.ts`), so the audit checks the chain before it
 *   checks the gates.
 */
function chainOf(router: IRouter): string[] {
  const stack = (router as unknown as { stack: { name?: string; route?: unknown }[] }).stack;
  const names: string[] = [];
  for (const layer of stack) {
    /* Everything up to the first ROUTE is the router-wide chain. */
    if (layer.route !== undefined) break;
    names.push(layer.name ?? '<anonymous>');
  }
  return names;
}

describe('every clinical router authenticates before it authorizes', () => {
  it.each(ROUTERS)('$name mounts the chain ahead of every route', ({ router }) => {
    expect(chainOf(router).slice(0, 3)).toEqual(['requireTenant', 'authenticate', 'requireAuth']);
  });
});

describe('every clinical route is gated', () => {
  it.each(ROUTERS)('$name has routes to audit', ({ router }) => {
    /* A guard on the guard: an empty stack would make every case below pass. */
    expect(routesOf(router).length).toBeGreaterThan(0);
  });

  it.each(ROUTERS)('$name gates all of them', ({ router }) => {
    const ungated = routesOf(router)
      .filter((route) => route.permissions === null || route.permissions.length === 0)
      .map((route) => `${route.method} ${route.path}`);

    expect(ungated).toEqual([]);
  });
});

/**
 * ⚠️ THE SPLIT INVARIANT 7 IS MADE OF, ROUTE BY ROUTE. Authoring the clinical
 *   record is `clinical.encounter.create` / `.close` / `.amend`, and nothing
 *   else may open that door — least of all a code an administrator holds.
 */
describe('the consultation surface splits reading from writing', () => {
  const routes = routesOf(encounterRoutes);

  const AUTHORING: string[] = [
    PERMISSIONS.ENCOUNTER_CREATE,
    PERMISSIONS.ENCOUNTER_CLOSE,
    PERMISSIONS.ENCOUNTER_AMEND,
  ];

  it('reads behind the read code, and nothing else', () => {
    const reads = routes.filter((route) => route.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);
    for (const route of reads) {
      expect(route.permissions).toEqual([PERMISSIONS.ENCOUNTER_READ]);
    }
  });

  /**
   * ⚠️ INCLUDING THE TWENTY-SEVEN BUILT FROM A TABLE (CE-4, CE-6). Recording a
   *   diagnosis, a prescription or a mark on a chart IS writing up the
   *   consultation (CD-7) — there is no `clinical.diagnosis.create`, and a route
   *   that invented one would be a second answer to "who may author the record".
   */
  it('writes behind an authoring code, and only an authoring code', () => {
    const writes = routes.filter((route) => route.method !== 'GET');
    expect(writes.length).toBeGreaterThanOrEqual(28);

    for (const route of writes) {
      expect(route.permissions).toHaveLength(1);
      expect(AUTHORING).toContain(route.permissions?.[0]);
    }
  });

  /** Signing and correcting are their own acts, and their own codes. */
  it('puts the signature and the correction behind their own codes', () => {
    const finalize = routes.find((route) => route.path.endsWith('/finalize'));
    const amend = routes.find((route) => route.path.endsWith('/amend'));

    expect(finalize?.permissions).toEqual([PERMISSIONS.ENCOUNTER_CLOSE]);
    expect(amend?.permissions).toEqual([PERMISSIONS.ENCOUNTER_AMEND]);
  });

  /**
   * ⚠️ DRAWING ON A CHART IS NOT CONFIGURING ONE (CD-7, CE-6). The findings
   *   collection is `clinical.encounter.create`; `clinical.visual_map.manage`
   *   says what the chart IS, and a doctor holds neither it nor a need for it.
   */
  it('keeps the chart’s marks on the authoring code, not the manage code', () => {
    const findings = routes.filter((route) => route.path.includes('/findings'));
    expect(findings.length).toBe(3);

    for (const route of findings) {
      expect(route.permissions).toEqual([PERMISSIONS.ENCOUNTER_CREATE]);
    }
  });
});

/**
 * ⚠️ CONFIGURING A CONSULTATION IS AN ADMINISTRATIVE ACT (CE-2, CE-6). Both
 *   manage codes are held by the owner and the administrator and by no
 *   clinician, so a WRITE on either surface that shipped behind an encounter
 *   code would hand every doctor in the practice the form every other doctor
 *   fills in.
 */
describe('configuring is not conducting', () => {
  it.each([
    { name: 'consultation-templates', router: consultationTemplateRoutes },
    { name: 'visual-maps', router: visualMapRoutes },
  ])('$name never writes behind an encounter code', ({ router }) => {
    const encounterCodes: string[] = [
      PERMISSIONS.ENCOUNTER_CREATE,
      PERMISSIONS.ENCOUNTER_CLOSE,
      PERMISSIONS.ENCOUNTER_AMEND,
    ];

    for (const route of routesOf(router)) {
      if (route.method === 'GET') continue;
      for (const code of route.permissions ?? []) {
        expect(encounterCodes).not.toContain(code);
      }
    }
  });
});

/**
 * ⚠️ INVARIANT 7 FROM THE OTHER SIDE (PI-7). The consultation surface is audited
 *   above for authoring behind an authoring code; the dispensary is audited here
 *   for authoring NOTHING. Pharmacy reads a prescription and writes only its own
 *   rows beside it — a route on this router carrying
 *   `clinical.encounter.create`, `.close`, `.amend` or `clinical.prescription.*`
 *   would be the dispensary inside the clinical record, and it would look
 *   entirely reasonable in a diff.
 */
describe('the dispensary reads the clinical record and never writes it', () => {
  const routes = routesOf(pharmacyRoutes);

  it('has routes to audit', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('carries no clinical authoring code on any route', () => {
    const authoring = routes.filter((route) =>
      (route.permissions ?? []).some((code) => code.startsWith('clinical.'))
    );
    expect(authoring).toEqual([]);
  });

  it('gates every write behind a pharmacy code', () => {
    const writes = routes.filter((route) => route.method !== 'GET');
    expect(writes.length).toBeGreaterThan(0);
    for (const route of writes) {
      expect(route.permissions).toHaveLength(1);
      expect(route.permissions?.[0]).toMatch(/^pharmacy\.dispense\./);
    }
  });

  /** Reading is one code, so a clinic grants "may see the counter" once. */
  it('reads behind the dispense read code, and nothing else', () => {
    const reads = routes.filter((route) => route.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);
    for (const route of reads) {
      expect(route.permissions).toEqual([PERMISSIONS.DISPENSE_READ]);
    }
  });
});

/**
 * ⚠️ THE ONE ROUTER WHERE ONE ROUTE IS A DISPENSE AND THE REST ARE NOT (PI-12).
 *   Packing a parcel writes the `dispenses` row, moves the ledger and raises the
 *   charge requests, so it is gated on `pharmacy.dispense.create` — the code that
 *   already means "this person may hand medicine over". Everything else on the
 *   router is order-taking and logistics behind `pharmacy.online_order.*`.
 *
 *   The failure this catches is the tidy one: somebody noticing the odd code out
 *   and "fixing" it to `pharmacy.online_order.manage`, which would hand the
 *   authority to supply to whoever answers the telephone.
 */
describe('taking an order is not supplying against it', () => {
  const routes = routesOf(onlineOrderRoutes);

  it('has routes to audit', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('carries no clinical code on any route', () => {
    const clinical = routes.filter((route) =>
      (route.permissions ?? []).some((code) => code.startsWith('clinical.'))
    );
    expect(clinical).toEqual([]);
  });

  it('reads behind the online-order read code, and nothing else', () => {
    const reads = routes.filter((route) => route.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);
    for (const route of reads) {
      expect(route.permissions).toEqual([PERMISSIONS.ONLINE_ORDER_READ]);
    }
  });

  it('gates packing on the code that means "may hand medicine over"', () => {
    const pack = routes.find((route) => route.path.endsWith('/pack'));
    expect(pack?.permissions).toEqual([PERMISSIONS.DISPENSE_CREATE]);
  });

  it('gates every other write behind an online-order code', () => {
    const writes = routes.filter(
      (route) => route.method !== 'GET' && !route.path.endsWith('/pack')
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const route of writes) {
      expect(route.permissions).toHaveLength(1);
      expect(route.permissions?.[0]).toMatch(/^pharmacy\.online_order\./);
    }
  });

  /**
   * ⚠️ ACCEPTING AN ORDER HOLDS STOCK, SO IT IS NOT A READ. `confirm` writes
   *   `RESERVATION` movements that take quantity out of `AVAILABLE`; gated on
   *   `.read` it would let anybody who can see the queue empty the shelf.
   */
  it('keeps accepting and standing down on the manage code', () => {
    for (const suffix of ['/confirm', '/cancel']) {
      const route = routes.find((entry) => entry.path.endsWith(suffix));
      expect(route?.permissions).toEqual([PERMISSIONS.ONLINE_ORDER_MANAGE]);
    }
  });

  it('keeps the courier half on the dispatch code', () => {
    for (const suffix of ['/ship', '/deliver', '/delivery-failed']) {
      const route = routes.find((entry) => entry.path.endsWith(suffix));
      expect(route?.permissions).toEqual([PERMISSIONS.ONLINE_ORDER_DISPATCH]);
    }
  });
});

/**
 * ⚠️ INVARIANT 7 A THIRD TIME (PI-9), AND THIS ROUTER IS THE ONE MOST LIKELY TO
 *   ACQUIRE A CLINICAL CODE BY MISTAKE. It is anchored to an encounter, it is
 *   rendered on the consultation page, and "recording what a procedure used"
 *   sounds like writing in the chart until you notice the row it writes is a
 *   stock movement. A `clinical.encounter.*` code here would read as tidy in a
 *   diff and would put the treatment room inside the clinical record.
 */
describe('consumption reads the consultation and never writes it', () => {
  const routes = routesOf(consumptionRoutes);

  it('has routes to audit', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('carries no clinical authoring code on any route', () => {
    const authoring = routes.filter((route) =>
      (route.permissions ?? []).some((code) => code.startsWith('clinical.'))
    );
    expect(authoring).toEqual([]);
  });

  it('gates every route behind a consumption code', () => {
    for (const route of routes) {
      expect(route.permissions).toHaveLength(1);
      expect(route.permissions?.[0]).toMatch(/^consumption\./);
    }
  });

  /**
   * ⚠️ AND THE TEMPLATE WRITES ARE BEHIND THE NARROWER CODE. Deciding what a
   *   procedure is EXPECTED to use sets the baseline every variance is measured
   *   against, at every branch; recording what one actually used is a daily act
   *   by whoever was in the room. A template write behind `consumption.record`
   *   would let anyone who can record also move the line they are measured
   *   against.
   */
  it('gates template writes behind the template code', () => {
    const templateWrites = routes.filter(
      (route) => route.method !== 'GET' && route.path.startsWith('/templates')
    );
    expect(templateWrites.length).toBeGreaterThan(0);
    for (const route of templateWrites) {
      expect(route.permissions).toEqual([PERMISSIONS.CONSUMPTION_TEMPLATE_MANAGE]);
    }
  });

  /** And every read is one code, so a clinic grants "may see this" once. */
  it('reads behind the consumption read code, and nothing else', () => {
    const reads = routes.filter((route) => route.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);
    for (const route of reads) {
      expect(route.permissions).toEqual([PERMISSIONS.CONSUMPTION_READ]);
    }
  });
});

/**
 * ⚠️ THE PHI SPLIT PI-10 IS BUILT AROUND, ASSERTED RATHER THAN DESCRIBED.
 *   TRACEABILITY.md says the patient link ALWAYS exists in the data and that who
 *   may SEE it is an access-control question. If `recall.trace.patients` ever
 *   stops being required on `/affected` — or starts being required on
 *   `/forward` — the design has silently inverted, and neither change would fail
 *   any other test in this repository.
 */
describe('recall separates the counts from the names', () => {
  const routes = [...routesOf(recallRoutes), ...routesOf(traceabilityRoutes)];

  it('has routes to audit', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('carries no clinical authoring code on any route', () => {
    const authoring = routes.filter((route) =>
      (route.permissions ?? []).some((code) => code.startsWith('clinical.'))
    );
    expect(authoring).toEqual([]);
  });

  it('gates every route behind a recall code', () => {
    for (const route of routes) {
      expect(route.permissions?.length ?? 0).toBeGreaterThan(0);
      for (const code of route.permissions ?? []) expect(code).toMatch(/^recall\./);
    }
  });

  it('requires the patient code on the affected-party route, and only there', () => {
    const trace = routesOf(traceabilityRoutes);
    const affected = trace.find((route) => route.path === '/affected');
    expect(affected?.permissions).toEqual([
      PERMISSIONS.RECALL_READ,
      PERMISSIONS.RECALL_TRACE_PATIENTS,
    ]);

    const others = [...routesOf(recallRoutes), ...trace].filter(
      (route) => route.path !== '/affected'
    );
    expect(others.length).toBeGreaterThan(0);
    for (const route of others) {
      expect(route.permissions).not.toContain(PERMISSIONS.RECALL_TRACE_PATIENTS);
    }
  });

  /**
   * ⚠️ EXECUTING AND RESOLVING ARE THE STOCK-MOVING ACTS, and they are the ones
   *   a clinic may want to withhold from whoever records the notice. A route
   *   that moved quantity behind `recall.notice.create` would collapse the split
   *   without changing a single permission name.
   */
  it('gates the stock-moving acts behind the execute code', () => {
    const moving = routesOf(recallRoutes).filter(
      (route) =>
        route.path.endsWith('/execute') ||
        route.path.endsWith('/resolve') ||
        route.path.endsWith('/close') ||
        route.path.endsWith('/cancel')
    );
    expect(moving.length).toBe(4);
    for (const route of moving) {
      expect(route.permissions).toEqual([PERMISSIONS.RECALL_EXECUTE]);
    }
  });
});

/**
 * ⚠️ INVARIANT 7 FROM A THIRD SIDE, AND THE ONE MOST LIKELY TO BE BROKEN BY
 *   SOMEBODY BEING HELPFUL (PI-22). Every report here answers in products, lots,
 *   suppliers and procedure TYPES. Two of them read the clinical consumption
 *   register to do it, and the obvious next feature request — "and show me which
 *   patients" — is one column away in the SQL and a completely different act:
 *   `recall.trace.patients` territory, with its own permission and a
 *   `data_access_logs` row per read. These cases are what makes that column a
 *   failing test rather than a merged pull request.
 */
describe('reports read the clinical record, name nobody, and write nothing', () => {
  const routes = routesOf(reportRoutes);

  it('has routes to audit', () => {
    expect(routes.length).toBe(10);
  });

  /**
   * ⚠️ A REPORT THAT ACCEPTED A `POST` WOULD BE A REPORT THAT CHANGED SOMETHING.
   *   Nothing in this domain has a write: a stored report answer is a second
   *   source of truth for a figure `stock_ledger` already holds exactly.
   */
  it('serves nothing but GET', () => {
    for (const route of routes) expect(route.method).toBe('GET');
  });

  it('carries no clinical code on any route', () => {
    const clinical = routes.filter((route) =>
      (route.permissions ?? []).some((code) => code.startsWith('clinical.'))
    );
    expect(clinical).toEqual([]);
  });

  /**
   * ⚠️ AND NO `recall.trace.patients` EITHER. That code buys a page of named
   *   people, and a report gated on it would be a bulk PHI disclosure wearing a
   *   management report's name.
   */
  it('carries no patient-tracing code on any route', () => {
    for (const route of routes) {
      expect(route.permissions ?? []).not.toContain(PERMISSIONS.RECALL_TRACE_PATIENTS);
    }
  });

  it('gates every route on exactly one report code', () => {
    for (const route of routes) {
      expect(route.permissions).toHaveLength(1);
      expect(route.permissions?.[0]).toMatch(/^report\./);
    }
  });

  /**
   * ⚠️ `report.export` IS NEVER A ROUTE'S OWN GATE, WHICH IS THE HALF OF THE
   *   EXPORT RULE A STACK AUDIT CAN SEE. It is applied CONDITIONALLY, inside the
   *   chain, when `?format=csv` is asked for — so it is always ON TOP of the
   *   report's own read code and never instead of it. A route that carried it as
   *   its `authorize` would be a report readable by anybody holding the export
   *   verb and nothing else.
   */
  it('never uses the export code as a route’s own gate', () => {
    for (const route of routes) {
      expect(route.permissions ?? []).not.toContain(PERMISSIONS.REPORT_EXPORT);
    }
  });
});
