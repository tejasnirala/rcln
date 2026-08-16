/**
 * Which template applies to this consultation?
 *
 * ⚠️ THIS FUNCTION IS THE ONLY PLACE THAT DECIDES, AND `apps/web` NEVER DECIDES
 *   AT ALL (§33). There is no `if (specialty === 'DENTISTRY')` in a component,
 *   in a page, or in a route — the server resolves, the browser renders what it
 *   was handed. The moment one screen branches on a specialty, adding the next
 *   specialty costs a screen, which is the exact outcome this programme exists
 *   to avoid.
 *
 * ── MOST SPECIFIC WINS, WALKING UP ───────────────────────────────────────────
 *
 *   HUMAN → MED → DERMATOLOGY → HAIR_AND_SCALP        the doctor's path
 *                                       ▲
 *   Hair & Scalp resolves its own template if one exists; otherwise
 *   Dermatology's; otherwise Medical's; otherwise the care context's default.
 *
 *   The same specificity rule as `@rcln/regulatory`'s `selection.ts`, and for
 *   the same reason: a clinic configures the level it cares about and inherits
 *   the rest. A clinic that writes one dentistry template gets it for every
 *   dental sub-specialty without writing eleven more.
 *
 * ⚠️ RESOLUTION NEVER RETURNS NOTHING WHEN A DEFAULT EXISTS, AND THE DEFAULT IS
 *   SEEDED PER CARE CONTEXT. A doctor with no classification at all still gets
 *   the general consultation (Scenario 3) because the platform ships a GENERAL
 *   template attached to the care-context root and the path always contains that
 *   root. If even that is missing the answer is a problem, not an empty screen —
 *   an unconfigured consultation is a state somebody has to fix, not one a
 *   clinician should discover with a patient in the chair.
 *
 * No Prisma here. The caller loads the candidates and passes them in.
 */
import type { Parsed, TemplateDefinition } from './types.js';

/** One template the caller found, already narrowed to the right care context. */
export interface TemplateCandidate {
  readonly templateId: string;
  readonly code: string;
  /**
   * The taxonomy node this template is attached to. `null` means the care
   * context itself — the default that applies when nothing more specific does.
   */
  readonly specialtyId: string | null;
  /** False for a platform row. Decides ties — see `resolveTemplate`. */
  readonly isOwn: boolean;
  /**
   * The latest PUBLISHED version, or `null` if the template has never been
   * published. A never-published template is not a candidate at all.
   */
  readonly publishedVersion: {
    readonly versionId: string;
    readonly version: number;
    readonly definition: TemplateDefinition;
  } | null;
}

export interface TemplateResolution {
  readonly templateId: string;
  readonly code: string;
  readonly versionId: string;
  readonly version: number;
  readonly definition: TemplateDefinition;
  /**
   * The node the winning template was attached to, and how far down the path it
   * sits. `null` / `0` is the care-context default. Returned because a screen
   * that says "using your clinic's Dentistry template" is how a clinic notices
   * it configured the wrong level.
   */
  readonly matchedSpecialtyId: string | null;
  readonly matchedDepth: number;
}

export interface ResolutionRequest {
  /**
   * The taxonomy path, ROOT FIRST: the care-context node, then each node down
   * to the doctor's classification. Never empty — the care context is always
   * known, because it is decided by the patient, not by the doctor.
   */
  readonly taxonomyPath: readonly string[];
  readonly candidates: readonly TemplateCandidate[];
}

/**
 * Resolve the template, or say why not.
 *
 * The order of the three steps is the whole behaviour:
 *
 *   1. drop candidates with no PUBLISHED version. ⚠️ BEFORE the specificity walk
 *      and not after: a clinic that started a Hair & Scalp template and never
 *      published it must fall back to Dermatology's, not get a resolution
 *      failure at the most specific level. A draft is work in progress and has
 *      never been a statement about how consultations are conducted.
 *   2. keep only candidates ON the path — the doctor's own node, its ancestors,
 *      or the care-context default.
 *   3. deepest wins; a tie goes to the clinic's own template over the
 *      platform's; a tie after that goes to the lower code, so the answer is
 *      the same on every run.
 *
 * ⚠️ STEP 3'S TIE-BREAK IS NOT COSMETIC. A clinic that writes its own dentistry
 *   template sits at exactly the same node as the platform's, and without the
 *   `isOwn` preference which one applies is whatever the query returned first —
 *   a clinic's configuration silently ignored, on a screen that shows a
 *   perfectly reasonable consultation.
 */
export function resolveTemplate(request: ResolutionRequest): Parsed<TemplateResolution> {
  if (request.taxonomyPath.length === 0) {
    return { ok: false, problem: 'no care context was resolved for this consultation' };
  }

  const depthOf = new Map<string, number>();
  request.taxonomyPath.forEach((id, index) => depthOf.set(id, index));

  const published = request.candidates.filter(
    (
      candidate
    ): candidate is TemplateCandidate & {
      publishedVersion: NonNullable<TemplateCandidate['publishedVersion']>;
    } => candidate.publishedVersion !== null
  );

  const onPath = published
    .map((candidate) => ({
      candidate,
      /* `null` is the care-context default, which is the root — depth 0. */
      depth: candidate.specialtyId === null ? 0 : (depthOf.get(candidate.specialtyId) ?? -1),
    }))
    .filter((entry) => entry.depth >= 0);

  if (onPath.length === 0) {
    return {
      ok: false,
      problem:
        'no published consultation template applies to this doctor and care context. Publish one, or publish a default for the care context.',
    };
  }

  onPath.sort((a, b) => {
    if (a.depth !== b.depth) return b.depth - a.depth;
    if (a.candidate.isOwn !== b.candidate.isOwn) return a.candidate.isOwn ? -1 : 1;
    return a.candidate.code.localeCompare(b.candidate.code);
  });

  const winner = onPath[0];
  /* Unreachable — `onPath` is non-empty above. Written out because
     `noUncheckedIndexedAccess` is on and a `!` is not allowed here. */
  if (winner === undefined) {
    return { ok: false, problem: 'no consultation template applies to this consultation' };
  }

  return {
    ok: true,
    value: {
      templateId: winner.candidate.templateId,
      code: winner.candidate.code,
      versionId: winner.candidate.publishedVersion.versionId,
      version: winner.candidate.publishedVersion.version,
      definition: winner.candidate.publishedVersion.definition,
      matchedSpecialtyId: winner.candidate.specialtyId,
      matchedDepth: winner.depth,
    },
  };
}
