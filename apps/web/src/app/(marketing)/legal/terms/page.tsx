import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Clause,
  DefinitionList,
  LegalDoc,
  List,
  Placeholder,
  Term,
} from '@/components/marketing/legal';

export const metadata: Metadata = {
  title: 'Terms of service',
  description:
    'The agreement between rcln and the clinics that use it — subscriptions, acceptable use, clinical responsibility, data ownership and termination.',
  alternates: { canonical: '/legal/terms' },
};

const UPDATED = '25 July 2026';

/**
 * These are B2B terms: the customer is a clinic, not a patient.
 *
 * Two clauses carry most of the risk and are deliberately blunt rather than
 * buried — clause 6 (rcln is not practising medicine, and is not a medical
 * device) and clause 10 (the clinic's data is the clinic's, and they can get it
 * out). Softening either would be the kind of thing that reads fine until it
 * matters.
 */
export default function TermsPage() {
  return (
    <LegalDoc
      title="Terms of service"
      updated={UPDATED}
      summary="The agreement between rcln and the clinic that subscribes to it. It covers what we owe you, what you owe us, who is responsible for clinical decisions, and what happens to your data when you leave."
    >
      <Clause id="agreement" n="1" title="This agreement">
        <p>
          These terms are between <Placeholder>LEGAL ENTITY NAME</Placeholder> (“rcln”, “we”) and
          the organisation that registers for an account (“<Term>Customer</Term>”, “you”). By
          creating an organisation, or by using rcln, you accept them. If you are accepting on
          behalf of a clinic, you confirm you are authorised to bind it.
        </p>
        <p>
          They incorporate the{' '}
          <Link href="/legal/privacy" className="text-drape underline underline-offset-2">
            privacy policy
          </Link>{' '}
          and the{' '}
          <Link href="/legal/dpa" className="text-drape underline underline-offset-2">
            data processing agreement
          </Link>
          . Where the DPA conflicts with these terms on the handling of personal data, the DPA wins.
        </p>
      </Clause>

      <Clause id="service" n="2" title="What rcln is">
        <p>
          rcln is software for running a clinical practice: appointments, patient records,
          prescriptions, laboratory and pharmacy workflow, inventory, and billing, across one or
          many branches. Your organisation gets its own address and its own isolated data.
        </p>
        <p>
          We may change, add or withdraw features. Where we withdraw something you materially rely
          on, we will give at least <Placeholder>FEATURE NOTICE PERIOD</Placeholder> notice.
        </p>
      </Clause>

      <Clause id="accounts" n="3" title="Accounts and access">
        <p>
          The person who registers becomes the organisation’s owner and can invite others and set
          their roles. You are responsible for who you let in and for what they do.
        </p>
        <List
          items={[
            'Credentials are personal. Shared logins destroy the audit trail, which is the record you will want if a clinical decision is ever questioned.',
            'You must remove access for people who leave your organisation.',
            <>
              Tell us promptly at <Placeholder>SECURITY EMAIL</Placeholder> if you believe an
              account has been compromised.
            </>,
            'Keep the details on your account accurate — we use them for security notices.',
          ]}
        />
      </Clause>

      <Clause id="fees" n="4" title="Subscription, trial and fees">
        <p>
          New organisations start on a 14-day trial with no card required. At the end of the trial,
          access continues only if a paid subscription is started. (14 days is the Starter plan’s
          trial, which is what self-serve signup creates — it is stated in the signup flow and on
          the plan record, so all three must be changed together.)
        </p>
        <List
          items={[
            'Fees are those shown on our pricing page or in your order form, in Indian Rupees, exclusive of GST which is charged additionally at the applicable rate.',
            'Subscriptions renew automatically for successive terms unless cancelled before the renewal date.',
            'Fees are payable in advance and, except where these terms say otherwise, are non-refundable for a period already started.',
            <>
              We may change prices with at least <Placeholder>PRICE NOTICE PERIOD</Placeholder>{' '}
              notice, effective at your next renewal. If you do not accept the change you may cancel
              before it takes effect.
            </>,
            'Plan limits — branches, staff accounts and other metered entitlements — are enforced at the point of use.',
          ]}
        />
        <p>
          If payment fails we will retry and notify you. If an invoice remains unpaid after{' '}
          <Placeholder>GRACE PERIOD</Placeholder>, the account moves to read-only: you keep access
          to your records and can export them, and you cannot create new ones.{' '}
          <Term>We do not delete clinical data for non-payment.</Term>
        </p>
      </Clause>

      <Clause id="acceptable" n="5" title="Acceptable use">
        <p>You agree not to:</p>
        <List
          items={[
            'Use rcln for anything unlawful, or in breach of the medical-practice rules that apply to you.',
            'Upload data you have no right to hold, or use patient data for a purpose the patient has not been told about.',
            'Attempt to reach another organisation’s data, probe our isolation controls, or circumvent access limits.',
            'Resell, sublicense or white-label rcln without our written agreement.',
            'Reverse-engineer the service, or use automated means to scrape it.',
            'Send messages through rcln that breach TRAI regulations or the messaging platforms’ own rules.',
          ]}
        />
        <p>
          Genuine, good-faith security research is welcome. Report findings to{' '}
          <Placeholder>SECURITY EMAIL</Placeholder> and give us a reasonable chance to fix them; we
          will not pursue you for testing that respects other customers’ data.
        </p>
      </Clause>

      <Clause id="clinical" n="6" title="Clinical responsibility — read this one">
        <p>
          <Term>
            rcln is a record-keeping and workflow tool. It does not practise medicine, and it is not
            a diagnostic or clinical-decision-support device.
          </Term>
        </p>
        <p>
          Every clinical judgement — diagnosis, prescription, dosage, interaction, referral, whether
          a result needs acting on — is made by a registered practitioner exercising their own
          professional judgement. Any calculation, template, alert, default or reminder in rcln is a
          convenience, not advice, and must be independently verified. You remain responsible for
          your compliance with the Clinical Establishments Act, NMC regulations, the Telemedicine
          Practice Guidelines, drug-dispensing rules and every other obligation of practice.
        </p>
        <p>
          Do not rely on rcln as your only copy of a clinical record. Export regularly and keep your
          own backups.
        </p>
      </Clause>

      <Clause id="availability" n="7" title="Availability and support">
        <p>
          We aim for <Placeholder>UPTIME TARGET</Placeholder> monthly availability, excluding
          planned maintenance, which we announce in advance and schedule outside Indian clinic hours
          where we can. Any service credits are set out at <Placeholder>SLA URL</Placeholder>.
        </p>
        <p>
          Support is available <Placeholder>SUPPORT HOURS</Placeholder> at{' '}
          <Placeholder>SUPPORT EMAIL</Placeholder>.
        </p>
      </Clause>

      <Clause id="ip" n="8" title="Intellectual property">
        <p>
          We own rcln — the software, its design and our trade marks. You get a non-exclusive,
          non-transferable right to use it for your own clinical operations for as long as your
          subscription is current. Nothing here transfers ownership of the software to you.
        </p>
        <p>
          If you send us feedback or a feature suggestion, we may use it without owing you anything.
          This does not give us any right to your data.
        </p>
      </Clause>

      <Clause id="third-party" n="9" title="Third-party services">
        <p>
          Some features depend on others: SMS and WhatsApp delivery, payment gateways, and the ABDM
          network. Those services set their own rules — messaging templates need pre-approval, and
          SMS in India requires TRAI DLT registration in your name where messages are sent as you.
          We are not responsible for a third party’s outage, rejection or policy change, though we
          will tell you when we know about one.
        </p>
      </Clause>

      <Clause id="data" n="10" title="Your data is yours">
        <p>
          <Term>
            You own the data you put into rcln. We claim no ownership of patient records, and we do
            not use them to train machine-learning models.
          </Term>
        </p>
        <p>
          We process personal data only as your Data Processor, on your instructions, under the{' '}
          <Link href="/legal/dpa" className="text-drape underline underline-offset-2">
            data processing agreement
          </Link>
          . You are the Data Fiduciary for your patients: obtaining consent, answering their
          requests and setting retention are yours to do, and we will help you do them.
        </p>
        <p>
          You can export your data in a machine-readable format at any time while your subscription
          is active, and for <Placeholder>EXPORT WINDOW</Placeholder> after it ends.
        </p>
      </Clause>

      <Clause id="termination" n="11" title="Ending the agreement">
        <p>
          You may cancel at any time, effective at the end of your current billing period. We may
          suspend or terminate for material breach that is not cured within{' '}
          <Placeholder>CURE PERIOD</Placeholder> of written notice, or immediately where continuing
          would put patient data or other customers at risk.
        </p>
        <p>
          On termination: access ends, export stays available for{' '}
          <Placeholder>EXPORT WINDOW</Placeholder>, and we then delete your data except where law
          requires us to keep it. Clauses 6, 8, 10, 12 and 13 survive.
        </p>
      </Clause>

      <Clause id="liability" n="12" title="Warranties and liability">
        <p>
          We provide rcln with reasonable skill and care. Beyond that, and to the extent the law
          allows, the service is provided as-is and we exclude implied warranties of merchantability
          and fitness for a particular purpose.
        </p>
        <p>
          Neither party is liable for indirect or consequential loss, or for loss of profit, revenue
          or goodwill. Our total liability in any twelve-month period is capped at the fees you paid
          us in that period.
        </p>
        <p>
          Nothing here limits liability that cannot lawfully be limited — including for death or
          personal injury caused by negligence, or for fraud.{' '}
          <Term>
            The cap does not reduce your own responsibility for clinical decisions under clause 6.
          </Term>
        </p>
      </Clause>

      <Clause id="general" n="13" title="General">
        <DefinitionList
          items={[
            {
              term: 'Governing law',
              detail: (
                <>
                  The laws of India. Courts at <Placeholder>CITY</Placeholder> have exclusive
                  jurisdiction.
                </>
              ),
            },
            {
              term: 'Changes',
              detail: (
                <>
                  We may amend these terms on <Placeholder>TERMS NOTICE PERIOD</Placeholder> notice
                  to your administrators. Continuing to use rcln after that is acceptance; if you
                  object, you may cancel.
                </>
              ),
            },
            {
              term: 'Assignment',
              detail:
                'You may not assign without our consent. We may assign to a successor of our business.',
            },
            {
              term: 'Force majeure',
              detail:
                'Neither party is liable for failure caused by events genuinely beyond its control.',
            },
            { term: 'Severability', detail: 'If a clause is unenforceable, the rest stands.' },
            {
              term: 'Entire agreement',
              detail:
                'These terms, the privacy policy and the DPA are the whole agreement between us.',
            },
          ]}
        />
        <p>
          Questions about these terms: <Placeholder>LEGAL EMAIL</Placeholder>.
        </p>
      </Clause>
    </LegalDoc>
  );
}
