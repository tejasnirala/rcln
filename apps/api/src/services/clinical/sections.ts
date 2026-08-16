/**
 * The one place the DATABASE's section types and the ENGINE's are asserted to be
 * the same set (CE-3).
 *
 * ⚠️ THE SET IS WRITTEN TWICE ON PURPOSE, AND THIS FILE IS THE PRICE.
 *   `encounter_sections.section_type` is a Postgres enum so that a typo'd
 *   section type cannot land as a row no component ever renders; the
 *   authoritative list is `ConsultationSectionType` in `@rcln/clinical`, because
 *   that is where the registry, the parser and the renderer agree on it.
 *
 *   Two declarations of one closed set drift silently — a member added to the
 *   engine and not to the schema fails at INSERT with a Postgres enum error at
 *   runtime, with a patient in the chair. The assertions below turn that into a
 *   TYPE ERROR at build time, in both directions:
 *
 *     engine ⊆ database   a section the engine can render must be storable
 *     database ⊆ engine    a section the database allows must have a component
 *
 * Nothing here runs. It exists entirely to be compiled.
 */
import type { ConsultationSectionType } from '@rcln/clinical';
import type { ClinicalSeverityValue, FindingSeverityValue } from '@rcln/contracts';
import type { ConsultationSectionType as DbConsultationSectionType } from '@rcln/db';

type Assert<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type SectionTypesAgree = Assert<Equal<ConsultationSectionType, DbConsultationSectionType>>;

/**
 * ⚠️ AND THE SAME TRAP, ONE TABLE OVER (CE-6). `findingSeverity` in
 *   `visual-mapping.ts` restates `clinicalSeverity` rather than importing it,
 *   because `encounter-content.ts` imports the finding shapes and a Zod module
 *   cycle fails at RUNTIME. Restating is the right call and the drift it
 *   invites is the wrong outcome, so the two lists are asserted equal here.
 */
export type FindingSeverityAgrees = Assert<Equal<ClinicalSeverityValue, FindingSeverityValue>>;
