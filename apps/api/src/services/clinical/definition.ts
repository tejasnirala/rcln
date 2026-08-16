/**
 * The one door between a stored JSONB `definition` and the rest of the API.
 *
 * ⚠️ EVERY READ OF `consultation_template_versions.definition` GOES THROUGH HERE
 *   (CD-10). The grammar lives in `@rcln/clinical`, is unit-tested there, and
 *   refuses a document that says nothing checkable. A service that reads the
 *   column directly has deleted that guarantee for its own callers, and the
 *   failure it re-opens is silent: a field that renders as optional because one
 *   key was misspelled.
 *
 * ⚠️ A STORED DOCUMENT THAT WILL NOT PARSE IS AN ERROR, NOT AN EMPTY
 *   CONFIGURATION. Every row in this table was validated on the way in, so a
 *   failure here means somebody wrote to the column outside the template service
 *   or the grammar moved under a stored row. Both are things a person fixes —
 *   and neither is something a clinician should meet as a blank consultation.
 */
import { parseTemplateDefinition, type TemplateDefinition } from '@rcln/clinical';
import { ValidationError } from '../../utils/errors.js';

export function parseStoredDefinition(definition: unknown, where: string): TemplateDefinition {
  const parsed = parseTemplateDefinition(definition);
  if (!parsed.ok) throw new ValidationError(`${where} cannot be read: ${parsed.problem}`);
  return parsed.value;
}
