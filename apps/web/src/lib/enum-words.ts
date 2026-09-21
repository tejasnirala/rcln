/**
 * An enum member as a person reads it.
 *
 * ⚠️ THIS EXISTS BECAUSE THERE WERE ALREADY TWO OF IT — one in `product-panel.tsx`
 *   and one in `charge-policy-list.tsx`, both private, both called `humanise`, and
 *   both doing the same thing to the same kind of value. A third would have been
 *   the exact failure `pnpm kb:find` exists to catch. Both now import this; the
 *   handful of places that still inline `value.toLowerCase().replace(/_/g, ' ')`
 *   are not touched here, and should reach for this the next time they are opened.
 *
 * ⚠️ SENTENCE CASE, NOT TITLE CASE. `MODIFIED_RELEASE` is "Modified release" —
 *   the way a pharmacist says it and the way every label in this product is set.
 *   Title Case reads as a proper noun and makes a dosage form look like a brand.
 *
 * NOT A TRANSLATION LAYER. When these need to be shown in another language they
 * need a real dictionary keyed on the enum member, and this becomes the fallback.
 */
export function humanise(value: string): string {
  if (value === '') return 'Not recorded';
  const lower = value.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** The same, as `<Select options>`. */
export function asOptions(values: readonly string[]): { value: string; label: string }[] {
  return values.map((value) => ({ value, label: humanise(value) }));
}
