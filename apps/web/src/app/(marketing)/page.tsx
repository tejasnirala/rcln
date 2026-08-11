import type { Metadata } from 'next';
import { Cta } from '@/components/marketing/cta';
import { DemoForm } from '@/components/marketing/demo-form';
import { JourneyRail } from '@/components/marketing/journey-rail';
import { Section, SectionHead } from '@/components/marketing/section';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

/*
 * The apex landing page (rcln.com).
 *
 * Claims here are held to what the product does or is committed to doing.
 * There are no customer logos, testimonials or usage counts, because there are
 * no customers yet and inventing them on a healthcare product is not a
 * marketing shortcut, it is a lie with a compliance surface.
 */

const HANDOFFS = [
  {
    tool: 'A paper OPD register',
    job: 'Tokens and the day’s list',
    breaks: 'The doctor cannot see it from the consulting room',
  },
  {
    tool: 'WhatsApp',
    job: 'Appointment requests',
    breaks: 'Nobody knows who confirmed and who did not turn up',
  },
  {
    tool: 'A billing book or Tally',
    job: 'Invoices and GST',
    breaks: 'Nothing ties a bill back to what was actually prescribed',
  },
  {
    tool: 'An Excel sheet',
    job: 'Medicine stock',
    breaks: 'Batch and expiry drift away from what is on the shelf',
  },
  {
    tool: 'The lab’s PDFs',
    job: 'Test results',
    breaks: 'They arrive by email and live in one person’s inbox',
  },
  {
    tool: 'A separate pharmacy till',
    job: 'Dispensing',
    breaks: 'Sold, but never deducted from the stock you counted',
  },
];

const MODULES = [
  {
    name: 'Appointments and queue',
    body: 'Slots per doctor per branch, walk-ins, tokens, and a waiting-room display that matches the register.',
  },
  {
    name: 'Consults and prescriptions',
    body: 'Vitals, complaints, diagnoses and a signed prescription checked against the patient’s own allergies and current medicines.',
  },
  {
    name: 'Pharmacy and inventory',
    body: 'Purchase orders, goods receipts, batches and expiry. Dispensing picks the earliest-expiring batch and moves the stock ledger itself.',
  },
  {
    name: 'Lab',
    body: 'Orders, samples, per-parameter results, verification and release. A blood count is twenty-two values, not one.',
  },
  {
    name: 'Billing and GST',
    body: 'One invoice for the whole visit, correct tax lines, credit notes and refunds, and a patient ledger that balances.',
  },
  {
    name: 'Reports',
    body: 'Collections, footfall, stock value and doctor-wise revenue, per branch and consolidated.',
  },
];

const ISOLATION = [
  {
    title: 'Your own address',
    body: 'Your clinic runs at your own subdomain with its own logins. There is no shared front door to get through.',
  },
  {
    title: 'Enforced by the database, not just the app',
    body: 'Every query carries the clinic it belongs to, and Postgres refuses rows that belong to anyone else. Application code alone is one bug away from a leak.',
  },
  {
    title: 'Cross-clinic rows cannot be written',
    body: 'Records are keyed by clinic and id together, so a row that points at another clinic’s data is not something the database will store.',
  },
  {
    title: 'Access is scoped to a role and a branch',
    body: 'A receptionist at one branch sees that branch. Grant somebody every branch and they see every branch. Nothing in between is implicit.',
  },
  {
    title: 'Reads are recorded, not only writes',
    body: 'After an incident the question is who looked at a file, not who changed it. Both are written down.',
  },
  {
    title: 'Hosted in India',
    body: 'Patient data stays in the Mumbai region.',
  },
];

const INDIA = [
  {
    label: 'GST that matches the rules',
    body: 'HSN codes on medicines, tax lines that hold up, and consultation billed exempt while the strip you dispensed is taxed.',
  },
  {
    label: 'Invoice numbers that reset in April',
    body: 'Separate series per branch, per financial year, without anyone editing a counter.',
  },
  {
    label: 'ABHA on the patient record',
    body: 'The number is part of the record from the start, so linking under ABDM is a step you take, not a migration.',
  },
  {
    label: 'WhatsApp and SMS reminders',
    body: 'Through DLT-registered templates, because in India the alternative is messages that silently never arrive.',
  },
  {
    label: 'UPI Autopay for your subscription',
    body: 'Recurring collection built for Indian mandates rather than a card gateway bolted on.',
  },
];

const PLANS = [
  {
    code: 'Starter',
    tagline: 'A single clinic finding its feet',
    price: '1,499',
    trial: '14-day trial',
    limits: ['1 branch', '10 staff logins', 'Up to 2,000 patients'],
    includes: ['Appointments, consults and prescriptions', 'Billing and GST', 'WhatsApp reminders'],
    excludes: ['Pharmacy and lab modules'],
  },
  {
    code: 'Growth',
    tagline: 'Multi-branch, pharmacy and lab included',
    price: '4,999',
    trial: '14-day trial',
    featured: true,
    limits: ['Up to 5 branches', '50 staff logins', 'Up to 25,000 patients'],
    includes: ['Everything in Starter', 'Pharmacy and inventory', 'Lab orders and results'],
    excludes: [],
  },
  {
    code: 'Enterprise',
    tagline: 'Hospital chains, unlimited branches',
    price: '14,999',
    trial: '30-day trial',
    limits: ['Unlimited branches', 'Unlimited staff logins', 'Unlimited patients'],
    includes: ['Everything in Growth', 'Your own domain', 'Priority support'],
    excludes: [],
  },
];

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="pt-16 pb-section sm:pt-24">
        <div className="mx-auto w-full max-w-6xl px-gutter">
          <p className="ring-signal/20 bg-signal-tint text-signal inline-flex items-center gap-2 rounded-sm px-2.5 py-1 font-mono text-[0.6875rem] font-medium tracking-[0.12em] uppercase ring-1">
            <span className="bg-signal size-1.5 rounded-full" />
            In build · taking design partners
          </p>

          <h1 className="font-display text-display mt-6 max-w-4xl text-balance">
            One record, from token to invoice.
          </h1>

          <p className="text-lead text-muted mt-7 max-w-2xl text-pretty">
            rcln runs the whole clinic day — front desk, consulting room, prescription, pharmacy,
            lab and billing — on a single patient record. Open a second branch and it is still a
            single patient record.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Cta href="#demo" event="cta_book_demo">
              Book a demo
            </Cta>
            <Cta href="#product" variant="secondary">
              See what it runs
            </Cta>
          </div>

          <JourneyRail />
        </div>
      </section>

      {/* The problem */}
      <Section id="problem" tone="card">
        <SectionHead
          eyebrow="The situation"
          title="Your clinic already has software. Six of them."
          lead="None of them talk to each other, so the joins are done by hand — by whoever is at the desk, between patients."
        />

        {/*
         * Three columns on a wide screen; stacked on a narrow one, where the
         * consequence gets a rule down its left edge so the three levels stay
         * distinguishable instead of running together.
         */}
        <ul className="mt-12 grid gap-px overflow-hidden rounded-lg bg-rule sm:mt-14">
          {HANDOFFS.map((row) => (
            <li
              key={row.tool}
              className="bg-card grid gap-1.5 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)] sm:items-baseline sm:gap-6 sm:px-6"
            >
              <span className="text-ink text-[0.9375rem] font-medium">{row.tool}</span>
              <span className="text-muted text-sm">{row.job}</span>
              <span className="border-rule text-muted border-l-2 pl-3 text-sm sm:border-l-0 sm:pl-0">
                <span
                  aria-hidden="true"
                  className="text-signal mr-2 hidden font-mono text-xs sm:inline-block"
                >
                  ↳
                </span>
                {row.breaks}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      {/* Modules */}
      <Section id="product">
        <SectionHead
          eyebrow="What it runs"
          title="Six jobs, one record"
          lead="Each of these is a module you can turn on. What makes them worth having together is that none of them keeps its own copy of the patient."
        />

        <div className="mt-12 grid gap-px overflow-hidden rounded-lg bg-rule sm:mt-14 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((module) => (
            <div key={module.name} className="bg-card px-6 py-7">
              <h3 className="text-ink text-[0.9375rem] font-medium">{module.name}</h3>
              <p className="text-muted mt-2.5 text-sm leading-relaxed">{module.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Branches */}
      <Section id="branches" tone="card">
        <div className="grid gap-12 lg:grid-cols-[1.1fr_1fr] lg:items-start lg:gap-20">
          <div>
            <SectionHead
              eyebrow="One clinic or forty"
              title="A solo clinic and a six-branch hospital are the same shape."
              lead="There is no separate multi-branch edition to migrate to. Your clinic is the account; a branch is a place it operates from. Adding the second one is a form, not a project."
            />
          </div>

          <dl className="divide-rule border-rule divide-y border-t">
            {[
              {
                term: 'Staff work where they work',
                desc: 'A doctor can consult at two branches and a manager can run only one. Roles are granted per branch, or across all of them.',
              },
              {
                term: 'Numbering stays local',
                desc: 'Each branch has its own patient numbers and its own invoice series, so nothing collides and nothing has to be renumbered later.',
              },
              {
                term: 'Stock moves between branches',
                desc: 'Transfer a batch and both ledgers move together. No branch quietly holds inventory the head office cannot see.',
              },
              {
                term: 'Reporting goes both ways',
                desc: 'Read one branch on its own, or all of them together, without exporting anything.',
              },
            ].map((item) => (
              <div key={item.term} className="py-5">
                <dt className="text-ink text-[0.9375rem] font-medium">{item.term}</dt>
                <dd className="text-muted mt-2 text-sm leading-relaxed">{item.desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      {/* Security — the one dark section, where the contrast budget goes */}
      <Section id="security" tone="ink">
        <SectionHead
          tone="ink"
          eyebrow="Isolation"
          title="Another clinic cannot read your patients."
          lead="Every clinic on rcln shares infrastructure. That is what makes it affordable, and it is also the thing that has to be impossible to get wrong — so it is enforced in more than one place."
        />

        <div className="mt-12 grid gap-px overflow-hidden rounded-lg bg-paper/10 sm:mt-14 sm:grid-cols-2 lg:grid-cols-3">
          {ISOLATION.map((item) => (
            <div key={item.title} className="bg-ink px-6 py-7">
              <h3 className="text-paper text-[0.9375rem] font-medium">{item.title}</h3>
              <p className="text-drape-tint/70 mt-2.5 text-sm leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* India */}
      <Section id="india">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.2fr] lg:gap-20">
          <SectionHead
            eyebrow="Built here, not localised later"
            title="The Indian details are not an add-on"
            lead="Most of what makes clinic software painful in India is the part that gets added last somewhere else."
          />

          <dl className="divide-rule border-rule divide-y border-t">
            {INDIA.map((item) => (
              <div key={item.label} className="py-5">
                <dt className="text-ink text-[0.9375rem] font-medium">{item.label}</dt>
                <dd className="text-muted mt-2 text-sm leading-relaxed">{item.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      {/* Pricing */}
      <Section id="pricing" tone="card">
        <SectionHead
          eyebrow="Pricing"
          title="Per clinic, not per doctor"
          lead="Charged monthly, or annually at ten months’ price. Every plan starts with a trial and no card."
        />

        {/* Two up from 640px: a single 700px-wide plan card at tablet width was
            mostly empty space. */}
        <div className="mt-12 grid gap-6 sm:mt-14 sm:grid-cols-2 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan.code}
              className={
                plan.featured
                  ? 'border-drape ring-drape/15 rounded-lg border bg-drape-tint/40 p-7 ring-4'
                  : 'border-rule rounded-lg border p-7'
              }
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-ink text-[0.9375rem] font-medium">{plan.code}</h3>
                {plan.featured ? <span className="eyebrow text-drape">Most clinics</span> : null}
              </div>
              <p className="text-muted mt-1.5 text-sm">{plan.tagline}</p>

              <p className="mt-6 flex items-baseline gap-1.5">
                <span className="font-display text-ink text-4xl tabular-nums">₹{plan.price}</span>
                <span className="text-muted text-sm">/month</span>
              </p>
              <p className="text-muted mt-1 font-mono text-[0.6875rem] tracking-wide">
                {plan.trial} · plus GST
              </p>

              <ul className="mt-6 space-y-2 text-sm">
                {plan.limits.map((limit) => (
                  <li key={limit} className="text-ink">
                    {limit}
                  </li>
                ))}
              </ul>

              {/*
               * The tick and the dash are decoration; without the visually
               * hidden words, "Pharmacy and lab modules" reads identically
               * whether it is in the plan or not (WCAG 1.4.1 — colour and shape
               * must not be the only carrier of meaning).
               */}
              <ul className="border-rule mt-5 space-y-2 border-t pt-5 text-sm">
                {plan.includes.map((item) => (
                  <li key={item} className="text-muted flex gap-2.5">
                    <span aria-hidden="true" className="text-drape">
                      ✓
                    </span>
                    <span>
                      <span className="sr-only">Included: </span>
                      {item}
                    </span>
                  </li>
                ))}
                {plan.excludes.map((item) => (
                  <li key={item} className="text-muted flex gap-2.5">
                    <span aria-hidden="true">—</span>
                    <span>
                      <span className="sr-only">Not included: </span>
                      {item}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      {/* Demo */}
      <Section id="demo">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.15fr] lg:gap-20">
          <SectionHead
            eyebrow="Design partners"
            title="Book a demo"
            lead="rcln is being built now, which means the clinics that come in early get to argue with it. Tell us how your day runs and we will show you where it is."
          />
          <DemoForm />
        </div>
      </Section>
    </>
  );
}
