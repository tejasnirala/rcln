/* eslint-disable react/jsx-key --
 * The arrays below are DATA passed to <Table> and <List>, not children rendered
 * in place. Both components key their own rows and cells when they map. Adding
 * a key here would attach it to an element that is never the thing iterated,
 * which is noise that reads like a misunderstanding.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { Clause, LegalDoc, List, Placeholder, Table, Term } from '@/components/marketing/legal';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description:
    'How rcln handles personal data — what we hold as a Data Fiduciary, what we only process on a clinic’s behalf, and the rights you can exercise.',
  alternates: { canonical: '/legal/privacy' },
};

const UPDATED = '25 July 2026';

/**
 * The document turns on one distinction, and it is stated before anything else:
 *
 *   For patient records, the CLINIC is the Data Fiduciary and rcln is only a
 *   Data Processor. We hold that data because a clinic asked us to, we act on
 *   their instructions, and a patient's rights are exercised against the clinic.
 *
 *   For the marketing site and for clinic staff accounts, rcln is itself the
 *   Data Fiduciary.
 *
 * Getting this backwards would have us answering erasure requests we have no
 * authority over, and would put the clinic's obligations on us. See the DPA for
 * the processor terms.
 */
export default function PrivacyPolicyPage() {
  return (
    <LegalDoc
      title="Privacy policy"
      updated={UPDATED}
      summary="rcln is practice software sold to clinics. Most of the health data in it is not ours — a clinic puts it there, and we hold it under their instructions. This explains which data we decide the purpose of, which we only process for someone else, and what you can ask of each."
    >
      <Clause id="who" n="1" title="Who this covers">
        <p>
          This policy is published by <Placeholder>LEGAL ENTITY NAME</Placeholder>, a company
          incorporated in India (CIN <Placeholder>CIN</Placeholder>), registered at{' '}
          <Placeholder>REGISTERED ADDRESS</Placeholder> (“rcln”, “we”, “us”). It applies to the rcln
          website and to the rcln practice-management platform.
        </p>
        <p>
          Terms used here follow the <Term>Digital Personal Data Protection Act, 2023</Term> (“DPDP
          Act”): a <Term>Data Principal</Term> is the individual the data is about, a{' '}
          <Term>Data Fiduciary</Term> decides why and how it is processed, and a{' '}
          <Term>Data Processor</Term> processes it on a Fiduciary’s behalf.
        </p>
      </Clause>

      <Clause id="roles" n="2" title="The distinction that matters">
        <p>
          rcln holds two very different kinds of data, and our obligations differ for each. Almost
          every question about your data resolves to which row of this table it falls in.
        </p>

        <Table
          head={['Data', 'Our role', 'Who you ask']}
          rows={[
            [
              'Patient records — demographics, appointments, prescriptions, lab results, dispensing, invoices',
              <>
                <Term>Processor</Term> only
              </>,
              'The clinic that treated you. They decide what is collected and for how long; we act on their instructions.',
            ],
            [
              'Clinic staff accounts — name, work email, mobile, role, branch, sign-in activity',
              <>
                <Term>Fiduciary</Term>
              </>,
              'Us. This is our own record of who may access the platform.',
            ],
            [
              'Prospect and website data — demo requests, billing contacts, support correspondence',
              <>
                <Term>Fiduciary</Term>
              </>,
              'Us.',
            ],
          ]}
        />

        <p>
          <Term>If you are a patient:</Term> we almost certainly do not have a direct relationship
          with you, and we cannot give you your records or delete them on request. Your clinic can.
          Contact them first; if you cannot reach them, write to us at{' '}
          <Placeholder>GRIEVANCE EMAIL</Placeholder> and we will route it.
        </p>
      </Clause>

      <Clause id="collect" n="3" title="What we collect as a Fiduciary">
        <p>Only these, and only for the purposes given.</p>
        <Table
          head={['What', 'Why', 'Basis']}
          rows={[
            [
              'Name, work email, mobile number',
              'To create and secure your account, and to send service notices such as a sign-in code or a security alert',
              'Necessary to provide a service you signed up for',
            ],
            [
              'Password (stored only as an Argon2id hash) and session records',
              'Authentication, and letting you see and end your active sessions',
              'Necessary to provide the service',
            ],
            [
              'IP address, browser user-agent, timestamps of sign-in and of significant actions',
              'Security, abuse prevention, and the audit trail a clinical system is expected to keep',
              'Legitimate use — security of the service',
            ],
            [
              'Demo-request details you type into our website form',
              'To contact you about rcln',
              'Your consent, given when you submit the form',
            ],
            [
              'Billing contact and payment references',
              'Invoicing, tax compliance, and collecting subscription fees',
              'Necessary for the contract, and legal obligation',
            ],
          ]}
        />
        <p>
          We do not sell personal data, we do not share it for anyone else’s marketing, and we do
          not use patient data to train machine-learning models.
        </p>
      </Clause>

      <Clause id="cookies" n="4" title="Cookies and tracking">
        <p>
          The rcln application sets two cookies, both strictly necessary: a short-lived access token
          and a refresh token. Both are <code>HttpOnly</code>, so page scripts cannot read them, and
          both are scoped to your clinic’s own subdomain — a session at one clinic is inert at
          another.
        </p>
        <p>
          We do not currently run analytics or advertising trackers on the marketing site, and there
          is no third-party tag on any page where health data is visible. If that changes we will
          ask for consent first and update this section before turning anything on.
        </p>
      </Clause>

      <Clause id="where" n="5" title="Where your data is kept">
        <p>
          All personal data is stored and processed in India, in the AWS Asia Pacific (Mumbai)
          region. Data is encrypted in transit and at rest. Particularly sensitive identifiers —
          including ABHA numbers — carry an additional layer of column-level encryption.
        </p>
        <p>
          Clinics share database infrastructure but not data. Every tenant-scoped table is protected
          by database-level row-level security, so a query issued for one clinic cannot return
          another’s rows even if the application layer is wrong.
        </p>
      </Clause>

      <Clause id="subprocessors" n="6" title="Who else touches it">
        <p>
          We use a small number of vendors, each under contract and each limited to what their
          function requires. Our current list:
        </p>
        <Table
          head={['Vendor', 'What for', 'Where']}
          rows={[
            [
              'Amazon Web Services',
              'Hosting, database, object storage, email delivery',
              'India (ap-south-1)',
            ],
            [
              <Placeholder>SMS PROVIDER</Placeholder>,
              'One-time sign-in codes and appointment reminders',
              'India',
            ],
            [
              <Placeholder>WHATSAPP BSP</Placeholder>,
              'Appointment messages, where a clinic enables them',
              <Placeholder>REGION</Placeholder>,
            ],
            [
              <Placeholder>PAYMENT GATEWAY</Placeholder>,
              'Subscription billing. Card details go to them, never to us',
              'India',
            ],
          ]}
        />
        <p>
          The current list is maintained at <Placeholder>SUBPROCESSOR PAGE URL</Placeholder>.
          Clinics are notified before we add one, as set out in the{' '}
          <Link href="/legal/dpa" className="text-drape underline underline-offset-2">
            data processing agreement
          </Link>
          .
        </p>
      </Clause>

      <Clause id="retention" n="7" title="How long we keep it">
        <p>
          Two rules pull in opposite directions here, and we would rather be plain about how we
          resolve them than pretend they agree.
        </p>
        <p>
          The DPDP Act gives a Data Principal the right to erasure. Indian medical-records law
          requires clinical records to be retained — at least three years for outpatient records,
          and longer where a case is or may become medico-legal. A clinic cannot lawfully delete a
          record simply because it was asked to.
        </p>
        <p>
          <Term>We resolve this as anonymisation rather than deletion.</Term> On a valid erasure
          request that a clinic accepts, identifying fields are irreversibly stripped so the
          clinical record survives for the statutory period without identifying anybody. Where a
          record is under a legal hold, nothing is changed until the hold lifts.
        </p>
        <Table
          head={['Data', 'Kept for']}
          rows={[
            [
              'Patient records',
              'As instructed by the clinic, subject to the statutory minimum. Anonymised rather than deleted where erasure is granted',
            ],
            ['Staff account records', 'While the account is active, then 90 days'],
            ['Audit and access logs', <Placeholder>AUDIT LOG RETENTION</Placeholder>],
            ['Demo requests', '24 months from last contact, or until you ask us to delete them'],
            ['Invoices and tax records', '8 years, as required by Indian tax law'],
            ['Backups', '30 days, after which they roll off automatically'],
          ]}
        />
        <p>
          When a clinic leaves rcln, their data is available for export for{' '}
          <Placeholder>EXPORT WINDOW</Placeholder> and deleted afterwards, except where retention is
          legally required.
        </p>
      </Clause>

      <Clause id="rights" n="8" title="Your rights">
        <p>Under the DPDP Act you may:</p>
        <List
          items={[
            'Ask what personal data we hold about you and how it is processed.',
            'Have inaccurate or incomplete data corrected or completed.',
            'Ask for erasure, subject to the retention rules in clause 7.',
            'Nominate someone to exercise these rights if you die or become incapacitated.',
            'Withdraw consent where consent is what we relied on — this does not undo processing already done.',
            'Complain to us, and then to the Data Protection Board of India if we do not resolve it.',
          ]}
        />
        <p>
          For anything in the first row of clause 2 — patient records — direct the request to the
          clinic. We will help them answer it, but we cannot decide it for them.
        </p>
      </Clause>

      <Clause id="security" n="9" title="Security, and what happens if it fails">
        <p>
          Passwords are hashed with Argon2id and never stored in a recoverable form. Access is
          governed per branch and per role, not per user, so people see what their job requires.
          Every change is written to an audit log, and reads of patient data are logged too — “who
          opened this file” is the question that gets asked after an incident.
        </p>
        <p>
          No system is immune. If a breach affects your personal data we will notify the Data
          Protection Board of India and affected Data Principals in the manner and within the time
          the DPDP Act requires. Where the affected data is a clinic’s, we notify the clinic without
          undue delay so they can meet their own obligations.
        </p>
      </Clause>

      <Clause id="children" n="10" title="Children">
        <p>
          Clinics treat children, and their records are held under this policy on the same basis as
          any other patient record — with the clinic as Fiduciary and consent handled by a parent or
          guardian under the DPDP Act. rcln accounts themselves are for clinic staff and are not
          offered to anyone under 18.
        </p>
      </Clause>

      <Clause id="contact" n="11" title="Contact and grievances">
        <p>
          Our Data Protection Officer is <Placeholder>DPO NAME</Placeholder>, reachable at{' '}
          <Placeholder>DPO EMAIL</Placeholder>. For grievances, write to{' '}
          <Placeholder>GRIEVANCE EMAIL</Placeholder>; we respond within{' '}
          <Placeholder>RESPONSE SLA</Placeholder> and resolve within the period prescribed by the
          DPDP Act.
        </p>
        <p>
          If you are not satisfied with our response you may complain to the Data Protection Board
          of India.
        </p>
      </Clause>

      <Clause id="changes" n="12" title="Changes">
        <p>
          We will post any change here and update the date at the top. Where a change materially
          affects how we handle your data, we will tell clinic administrators by email at least{' '}
          <Placeholder>NOTICE PERIOD</Placeholder> before it takes effect.
        </p>
      </Clause>
    </LegalDoc>
  );
}
