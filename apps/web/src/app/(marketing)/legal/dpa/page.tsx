/* eslint-disable react/jsx-key --
 * The arrays below are DATA passed to <Table> and <List>, not children rendered
 * in place. Both components key their own rows and cells when they map.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Clause,
  DefinitionList,
  LegalDoc,
  List,
  Placeholder,
  Table,
  Term,
} from '@/components/marketing/legal';

export const metadata: Metadata = {
  title: 'Data processing agreement',
  description:
    'The processor terms between rcln and a clinic — scope of processing, security measures, subprocessors, breach notification, and what happens to data at the end.',
  alternates: { canonical: '/legal/dpa' },
};

const UPDATED = '25 July 2026';

/**
 * The processor half of the relationship, written to be attachable to a
 * clinic's own compliance file.
 *
 * Annexes are the part auditors actually read, so they are real tables rather
 * than prose: what is processed, who else touches it, and which technical
 * measures are claimed. Every claim in Annexe C is one this codebase actually
 * implements — do not add a row here to win a deal before the control exists.
 */
export default function DpaPage() {
  return (
    <LegalDoc
      title="Data processing agreement"
      updated={UPDATED}
      summary="When a clinic uses rcln, the clinic is the Data Fiduciary for its patients and rcln is its Data Processor. This sets out what we may do with that data, how we protect it, who else touches it, and what happens when the relationship ends."
    >
      <Clause id="parties" n="1" title="Parties and precedence">
        <p>
          This agreement is between the organisation subscribing to rcln (the “
          <Term>Fiduciary</Term>
          ”) and <Placeholder>LEGAL ENTITY NAME</Placeholder> (the “<Term>Processor</Term>”). It
          forms part of the{' '}
          <Link href="/legal/terms" className="text-drape underline underline-offset-2">
            terms of service
          </Link>{' '}
          and takes effect when the Fiduciary creates an organisation.
        </p>
        <p>
          Where it conflicts with the terms of service on the processing of personal data, this
          agreement prevails. Terms follow the{' '}
          <Term>Digital Personal Data Protection Act, 2023</Term> and, where still applicable, the
          Information Technology Act, 2000 and the SPDI Rules, 2011.
        </p>
        <p>
          A Fiduciary requiring a countersigned copy on its own paper may request one at{' '}
          <Placeholder>LEGAL EMAIL</Placeholder>.
        </p>
      </Clause>

      <Clause id="roles" n="2" title="Roles">
        <p>
          The Fiduciary determines the purpose and means of processing personal data about its
          patients and staff. The Processor processes that data only to provide the service, and
          only on the Fiduciary’s documented instructions — of which this agreement and the ordinary
          use of the product are the standing set.
        </p>
        <p>
          The Processor will tell the Fiduciary if it believes an instruction breaches applicable
          data protection law, and may pause that instruction until it is resolved.
        </p>
        <p>
          The Processor acts as a Fiduciary in its own right for the account and website data
          described in its{' '}
          <Link href="/legal/privacy" className="text-drape underline underline-offset-2">
            privacy policy
          </Link>
          . That data is outside this agreement.
        </p>
      </Clause>

      <Clause id="obligations" n="3" title="What the Processor undertakes">
        <List
          items={[
            'To process personal data only on the Fiduciary’s instructions, and never for its own purposes.',
            <>
              <Term>
                Not to use patient data to train machine-learning models, and not to sell it or
                share it for anyone’s marketing.
              </Term>
            </>,
            'To restrict access to personnel who need it for their role, each bound by confidentiality obligations that survive their engagement.',
            'To keep the technical and organisational measures in Annexe C, and not to materially weaken them during the term.',
            'To assist the Fiduciary in responding to Data Principal requests, and with breach notification and any impact assessment.',
            'To make available the information reasonably needed to demonstrate compliance with this agreement.',
          ]}
        />
      </Clause>

      <Clause id="rights" n="4" title="Data Principal requests">
        <p>
          Patients exercise their rights against the Fiduciary, not the Processor. The product
          provides the means to search, export, correct and anonymise records so the Fiduciary can
          answer directly.
        </p>
        <p>
          If a Data Principal contacts the Processor about data belonging to a Fiduciary, the
          Processor will not respond substantively; it will direct them to the Fiduciary and inform
          the Fiduciary without undue delay.
        </p>
      </Clause>

      <Clause id="erasure" n="5" title="Erasure against medical retention">
        <p>
          Erasure requests and record-retention law conflict, and this agreement resolves the
          conflict explicitly rather than leaving it to a support ticket.
        </p>
        <p>
          Indian law requires clinical records to be retained — at least three years for outpatient
          records and longer where a matter is or may become medico-legal. Where a Fiduciary grants
          an erasure request over such a record, the Processor gives effect to it by{' '}
          <Term>irreversible anonymisation</Term>: identifying fields are destroyed and the clinical
          record is retained without an identifiable subject for the remainder of the statutory
          period, after which it is deleted.
        </p>
        <p>
          Records under legal hold are not altered until the hold lifts. The Fiduciary decides
          whether a request is valid and whether a hold applies.
        </p>
      </Clause>

      <Clause id="subprocessors" n="6" title="Subprocessors">
        <p>
          The Fiduciary gives general authorisation for the Processor to engage subprocessors. Each
          is bound by written terms no less protective than these, and the Processor remains fully
          liable for their acts and omissions.
        </p>
        <p>
          The current list is at Annexe B and maintained at{' '}
          <Placeholder>SUBPROCESSOR PAGE URL</Placeholder>. The Processor will give at least{' '}
          <Placeholder>SUBPROCESSOR NOTICE PERIOD</Placeholder> notice before adding or replacing
          one. A Fiduciary with a reasonable, data-protection-based objection may raise it within
          that period; if it cannot be resolved, the Fiduciary may terminate the affected service
          without penalty and receive a pro-rata refund of prepaid fees.
        </p>
      </Clause>

      <Clause id="breach" n="7" title="Personal data breach">
        <p>
          The Processor will notify the Fiduciary without undue delay, and in any event within{' '}
          <Placeholder>BREACH NOTIFICATION WINDOW</Placeholder> of becoming aware of a personal data
          breach affecting the Fiduciary’s data.
        </p>
        <p>The notification will include, so far as known at the time:</p>
        <List
          items={[
            'The nature of the breach, and the categories and approximate number of records affected.',
            'The likely consequences.',
            'The measures taken or proposed, including anything the Fiduciary should do.',
            'A contact point for further information.',
          ]}
        />
        <p>
          Notifying the Data Protection Board of India and affected Data Principals is the
          Fiduciary’s responsibility where the data is theirs; the Processor will provide what is
          needed to do it on time.
        </p>
      </Clause>

      <Clause id="audit" n="8" title="Audit">
        <p>
          On reasonable written notice and not more than once a year — or after a breach affecting
          the Fiduciary — the Processor will provide its then-current security documentation and
          answer a reasonable security questionnaire.
        </p>
        <p>
          Where that is genuinely insufficient for a Fiduciary’s regulatory obligations, an audit
          may be conducted by an independent auditor, during business hours, without unreasonable
          disruption, subject to confidentiality, and at the Fiduciary’s cost. Audits must not
          access another customer’s data.
        </p>
      </Clause>

      <Clause id="transfers" n="9" title="Location and transfers">
        <p>
          All personal data is stored and processed in India, in the AWS Asia Pacific (Mumbai)
          region. The Processor will not transfer personal data outside India except where a
          subprocessor listed in Annexe B is identified as processing outside India, and then only
          to a country not restricted by the Central Government under the DPDP Act.
        </p>
      </Clause>

      <Clause id="end" n="10" title="Return and deletion">
        <p>
          On termination the Fiduciary may export its data for{' '}
          <Placeholder>EXPORT WINDOW</Placeholder>. After that the Processor deletes it from live
          systems within <Placeholder>DELETION WINDOW</Placeholder>, and from backups as those
          backups expire on their ordinary 30-day cycle.
        </p>
        <p>
          Data the Processor is required by law to retain is kept only for that purpose and remains
          subject to this agreement. The Processor will certify deletion in writing on request.
        </p>
      </Clause>

      <Clause id="liability" n="11" title="Liability and term">
        <p>
          Liability under this agreement is subject to the limitations in the terms of service. This
          agreement continues for as long as the Processor processes personal data on the
          Fiduciary’s behalf.
        </p>
      </Clause>

      <Clause id="annexe-a" n="A" title="Annexe A — Details of processing">
        <DefinitionList
          items={[
            {
              term: 'Subject matter',
              detail: 'Provision of the rcln practice-management platform.',
            },
            {
              term: 'Duration',
              detail: 'The term of the subscription, plus the export and deletion windows.',
            },
            {
              term: 'Nature and purpose',
              detail:
                'Storage, organisation, retrieval, and transmission of clinical and administrative records so the Fiduciary can run its practice — scheduling, treatment, dispensing, billing and reporting.',
            },
            {
              term: 'Categories of Data Principal',
              detail:
                'Patients and their nominees; the Fiduciary’s clinicians, staff and administrators; supplier contacts.',
            },
            {
              term: 'Categories of personal data',
              detail:
                'Identity and contact details; date of birth and sex; ABHA number where provided; appointment and visit records; clinical notes, diagnoses, prescriptions and laboratory results; dispensing records; invoices, payments and insurance details; staff role and access records.',
            },
            {
              term: 'Sensitive personal data',
              detail:
                'Health data throughout, and financial data in billing. Processed under the same terms, with the additional measures in Annexe C.',
            },
          ]}
        />
      </Clause>

      <Clause id="annexe-b" n="B" title="Annexe B — Subprocessors">
        <Table
          head={['Subprocessor', 'Purpose', 'Location']}
          rows={[
            [
              'Amazon Web Services India',
              'Hosting, managed database, object storage, transactional email',
              'India (ap-south-1)',
            ],
            [
              <Placeholder>SMS PROVIDER</Placeholder>,
              'One-time codes and transactional SMS',
              'India',
            ],
            [
              <Placeholder>WHATSAPP BSP</Placeholder>,
              'WhatsApp messaging, where enabled by the Fiduciary',
              <Placeholder>REGION</Placeholder>,
            ],
            [
              <Placeholder>PAYMENT GATEWAY</Placeholder>,
              'Subscription billing. Does not receive patient data',
              'India',
            ],
          ]}
        />
        <p className="text-muted text-[0.875rem]">
          Verify each entry against live infrastructure before publishing. A subprocessor list that
          names a vendor you are not using — or omits one you are — is a misrepresentation in a
          compliance document.
        </p>
      </Clause>

      <Clause id="annexe-c" n="C" title="Annexe C — Technical and organisational measures">
        <Table
          head={['Control', 'Measure']}
          rows={[
            [
              'Tenant isolation',
              'Every tenant-scoped table is protected by PostgreSQL row-level security, enforced for the application role, which holds no bypass privilege. Cross-tenant foreign keys are structurally unrepresentable. Isolation is asserted by an automated test suite on every change.',
            ],
            [
              'Access control',
              'Role-based, scoped per branch, with explicit grant and deny overrides. Permissions are resolved per request rather than carried in the session token, so a revoked role takes effect within seconds.',
            ],
            [
              'Authentication',
              'Passwords hashed with Argon2id at OWASP-baseline parameters. Session tokens are short-lived; refresh tokens are single-use, rotated, and replay of a rotated token revokes every session for that user. Accounts lock after repeated failures.',
            ],
            ['Encryption in transit', 'TLS on all external connections.'],
            [
              'Encryption at rest',
              'Managed encryption on database, object storage and cache. Additional column-level encryption for ABHA numbers and other high-sensitivity identifiers.',
            ],
            [
              'Audit',
              'Every mutation is written to an immutable audit log. Reads of patient data are logged separately, so “who opened this record” is answerable.',
            ],
            [
              'Logging hygiene',
              'Patient names, contact details and credentials are redacted from application logs by policy and by configuration. Identifiers only.',
            ],
            [
              'Backups',
              'Automated backups with point-in-time recovery and 30-day retention, held in-region. Restores tested periodically.',
            ],
            [
              'Segregation',
              'Development and staging environments never hold production patient data.',
            ],
            [
              'Vulnerability management',
              'Automated dependency and container scanning in the build pipeline, with patching on a risk-based schedule.',
            ],
            ['Personnel', 'Access on a need-to-know basis, under confidentiality obligations.'],
          ]}
        />
      </Clause>
    </LegalDoc>
  );
}
