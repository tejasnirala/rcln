/**
 * Regulatory, from a clinic's side — reading the law, and asking the engine.
 *
 * ⚠️ THERE IS NO WRITE ON THIS ROUTER, AND THAT IS THE WHOLE POINT. A clinic
 *   never writes a rule pack: the law of a country is the same for everybody in
 *   it. Four independent layers say so — `regulatory.rule.manage` is excluded
 *   from ORG_OWNER by name in `roles.ts`, the authoring console lives on the
 *   platform host, this router has no write route, and the database's
 *   `platform_law_not_tenant_writable` trigger refuses a write from any
 *   transaction that claims a tenant. Four, because the thing being protected is
 *   what every other clinic on the platform is evaluated against.
 *
 *   What a clinic DOES write is its own products' regulatory profiles, and those
 *   live on `/api/v1/products/{productId}/regulatory-profiles` behind
 *   `product.regulatory.manage`.
 *
 * ⚠️ NO PHI HERE, INCLUDING IN THE EVALUATION REQUEST. A rule needs to know
 *   whether somebody is sixteen; it never needs to know who they are. There is
 *   no patient id in the contract.
 */
import {
  jurisdictionListResponse,
  regulatoryAuthorityListResponse,
  regulatoryDecisionResponse,
  regulatoryRuleListResponse,
  regulatorySourceListResponse,
  rulePackListResponse,
  rulePackSummary,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  AUTHORITY_ID,
  BRANCH_ID,
  JURISDICTION_ID,
  JURISDICTION_KA_ID,
  PRODUCT_ID,
  REGULATORY_SOURCE_ID,
  RULE_ID,
  RULE_PACK_ID,
} from './fixtures.js';

export const regulatoryDocs: DocRegistry = {
  'GET /api/v1/regulatory/jurisdictions': {
    summary: 'List jurisdictions',
    description:
      'The countries and regions rcln holds law for. Platform data, identical for every clinic — a clinic reads this to find out which jurisdiction its branches fall under, never to change one.',
    response: jurisdictionListResponse,
    params: {
      countryCode: 'Narrow to one country, ISO 3166-1 alpha-2.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'India, and Karnataka within it',
        value: {
          success: true,
          message: 'Success',
          data: {
            jurisdictions: [
              {
                id: JURISDICTION_ID,
                countryCode: 'IN',
                regionCode: null,
                name: 'India',
                isActive: true,
              },
              {
                id: JURISDICTION_KA_ID,
                countryCode: 'IN',
                regionCode: 'KA',
                name: 'Karnataka',
                isActive: true,
              },
            ],
            total: 2,
            page: 1,
            pageSize: 25,
          },
        },
      },
    ],
  },

  'GET /api/v1/regulatory/authorities': {
    summary: 'List regulators',
    description:
      'The bodies whose rules apply — CDSCO, a state drugs controller. Read-only from a clinic. Useful for showing *who* refused a supply, which is a different question from *what* rule refused it.',
    response: regulatoryAuthorityListResponse,
    params: {
      jurisdictionId: 'Narrow to one jurisdiction.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'The Indian drug regulator',
        value: {
          success: true,
          message: 'Success',
          data: {
            authorities: [
              {
                id: AUTHORITY_ID,
                code: 'CDSCO',
                name: 'Central Drugs Standard Control Organisation',
                jurisdictionId: JURISDICTION_ID,
                isActive: true,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 25,
          },
        },
      },
    ],
  },

  'GET /api/v1/regulatory/sources': {
    summary: 'List legal sources',
    description:
      'The documents the rules were drawn from — an act, a schedule, a circular — with where to read them. This is what lets a clinic answer "on what authority" when a supply is refused, rather than only "the system said no".',
    response: regulatorySourceListResponse,
    params: {
      jurisdictionId: 'Narrow to one jurisdiction.',
      authorityId: 'Narrow to one regulator.',
      status: 'Filter by source status.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'The Drugs and Cosmetics Rules',
        value: {
          success: true,
          message: 'Success',
          data: {
            sources: [
              {
                id: REGULATORY_SOURCE_ID,
                code: 'IN-DC-RULES-1945',
                title: 'Drugs and Cosmetics Rules, 1945',
                authorityId: AUTHORITY_ID,
                jurisdictionId: JURISDICTION_ID,
                status: 'IN_FORCE',
                citationUrl: 'https://cdsco.gov.in/',
                effectiveFrom: '1945-12-21',
              },
            ],
            total: 1,
            page: 1,
            pageSize: 25,
          },
        },
      },
    ],
  },

  'GET /api/v1/regulatory/rule-packs': {
    summary: 'List rule packs',
    description: `
The versioned bundles of rules in force for a jurisdiction.

⚠️ **\`maturity\` is not decoration.** It says how far a pack has been through
review — from an imported draft to \`PRODUCTION_ENABLED\` — and an evaluation
reports the **lowest** maturity of every pack that contributed to its decision.
A decision resting on an unreviewed pack is a decision a clinic should treat
differently from one resting on a production pack, and \`lowestPackMaturity\` is
how it can tell.
`.trim(),
    response: rulePackListResponse,
    params: {
      jurisdictionId: 'Narrow to one jurisdiction.',
      maturity: 'Filter by review maturity.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'The Indian schedule pack, live',
        value: {
          success: true,
          message: 'Success',
          data: {
            rulePacks: [
              {
                id: RULE_PACK_ID,
                code: 'IN-CDSCO-SCHEDULES',
                version: '2026.1',
                jurisdictionId: JURISDICTION_ID,
                authorityId: AUTHORITY_ID,
                maturity: 'PRODUCTION_ENABLED',
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
                ruleCount: 42,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 25,
          },
        },
      },
    ],
  },

  'GET /api/v1/regulatory/rule-packs/{packId}': {
    summary: 'Get a rule pack',
    description:
      'One pack, with the source it was drawn from and its review state. Read-only — a clinic cannot approve, edit or retire a pack.',
    response: rulePackSummary,
    params: { packId: 'The pack, as `GET /api/v1/regulatory/rule-packs` lists it.' },
    responseExamples: [
      {
        summary: 'A live pack',
        value: {
          success: true,
          message: 'Success',
          data: {
            id: RULE_PACK_ID,
            code: 'IN-CDSCO-SCHEDULES',
            version: '2026.1',
            jurisdictionId: JURISDICTION_ID,
            authorityId: AUTHORITY_ID,
            sourceId: REGULATORY_SOURCE_ID,
            maturity: 'PRODUCTION_ENABLED',
            effectiveFrom: '2026-01-01',
            effectiveTo: null,
            ruleCount: 42,
          },
        },
      },
    ],
  },

  'GET /api/v1/regulatory/rules': {
    summary: 'List rules',
    description:
      'The individual rules inside the packs — what each one checks, what it does when it fires, and the message it carries. A clinic reads these to understand a refusal it has already received, or to anticipate one.',
    response: regulatoryRuleListResponse,
    params: {
      packId: 'Narrow to one pack.',
      ruleType: 'Filter by what the rule governs.',
      transaction: 'Filter to rules that apply to one kind of transaction.',
      status: 'Filter by rule status.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'The Schedule H prescription rule',
        value: {
          success: true,
          message: 'Success',
          data: {
            rules: [
              {
                id: RULE_ID,
                packId: RULE_PACK_ID,
                code: 'IN-CDSCO-SCHEDULE-H-RX',
                ruleType: 'PRESCRIPTION_REQUIRED',
                transaction: 'DISPENSE',
                status: 'ACTIVE',
                outcome: 'REFUSED',
                message: 'A Schedule H medicine requires a valid prescription.',
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 25,
          },
        },
      },
    ],
  },

  'POST /api/v1/regulatory/evaluate': {
    summary: 'Ask what the rules would say',
    description: `
"What would the rules say about this transaction?"

⚠️ **A QUESTION, NOT AN AUTHORISATION.** It moves no stock and permits nothing,
which is why it is gated on the **read** code. Whoever eventually *acts* on a
decision is gated on the code for that act and **calls the same service again** —
nothing in this system ever trusts a decision a client sends back.

⚠️ **\`UNDETERMINED\` IS A REFUSAL.** It arrives as a \`200\` with a decision in
it — the question *was* answered — and any client that renders it as anything
other than "we cannot permit this" has reintroduced the permissive default the
whole domain is shaped against. The engine does not guess when it lacks a rule or
a product profile; it says so, and saying so means no.

\`hasProfile: false\` says this product has no regulatory profile in this
jurisdiction, which is usually why an answer came back undetermined.

\`reasons\` carries every rule that contributed, with its own sentence — that
text is written to be shown to the person being refused, not paraphrased.
\`lowestPackMaturity\` says how well-reviewed the weakest contributing pack is.

**No patient identity is sent or accepted.** A rule needs an age, not a name.
`.trim(),
    response: regulatoryDecisionResponse,
    errors: [422],
    requestExamples: [
      {
        summary: 'Dispensing a Schedule H medicine with a prescription',
        value: {
          productId: PRODUCT_ID,
          transaction: 'DISPENSE',
          branchId: BRANCH_ID,
          quantityBase: '15',
          prescription: {
            presented: true,
            signedByQualifiedPrescriber: true,
            issuedOn: '2026-03-17',
            refillsUsed: 0,
          },
          patient: { ageYears: 47, subjectType: 'HUMAN' },
        },
      },
      {
        summary: 'The same supply with no prescription',
        description: "Comes back `REFUSED`, carrying the rule's own sentence.",
        value: {
          productId: PRODUCT_ID,
          transaction: 'DISPENSE',
          branchId: BRANCH_ID,
          quantityBase: '15',
          prescription: {
            presented: false,
            signedByQualifiedPrescriber: false,
            issuedOn: '2026-03-17',
          },
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Permitted',
        value: {
          success: true,
          message: 'Success',
          data: {
            outcome: 'PERMITTED',
            conditions: [],
            reasons: [],
            packVersionIds: [RULE_PACK_ID],
            lowestPackMaturity: 'PRODUCTION_ENABLED',
            jurisdiction: 'IN-KA',
            hasProfile: true,
            evaluatedAt: '2026-03-17T04:37:00.000Z',
          },
        },
      },
      {
        summary: 'Refused',
        description: 'At the counter this same decision arrives as a `422`, not a `403`.',
        value: {
          success: true,
          message: 'Success',
          data: {
            outcome: 'REFUSED',
            conditions: [],
            reasons: [
              {
                ruleId: RULE_ID,
                ruleCode: 'IN-CDSCO-SCHEDULE-H-RX',
                ruleType: 'PRESCRIPTION_REQUIRED',
                packId: RULE_PACK_ID,
                packVersion: '2026.1',
                outcome: 'REFUSED',
                message: 'A Schedule H medicine requires a valid prescription.',
              },
            ],
            packVersionIds: [RULE_PACK_ID],
            lowestPackMaturity: 'PRODUCTION_ENABLED',
            jurisdiction: 'IN-KA',
            hasProfile: true,
            evaluatedAt: '2026-03-17T04:37:00.000Z',
          },
        },
      },
      {
        summary: 'Undetermined — which means no',
        description:
          'No profile for this product in this jurisdiction. A `200`, and still a refusal.',
        value: {
          success: true,
          message: 'Success',
          data: {
            outcome: 'UNDETERMINED',
            conditions: [],
            reasons: [
              {
                ruleId: null,
                ruleCode: null,
                ruleType: null,
                packId: null,
                packVersion: null,
                outcome: 'UNDETERMINED',
                message: 'This product has no regulatory profile for IN-KA.',
              },
            ],
            packVersionIds: [],
            lowestPackMaturity: null,
            jurisdiction: 'IN-KA',
            hasProfile: false,
            evaluatedAt: '2026-03-17T04:37:00.000Z',
          },
        },
      },
    ],
  },
};
