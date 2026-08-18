/**
 * Zod contracts -> OpenAPI 3.1 component schemas.
 *
 * ⚠️ THE CONTRACTS ARE THE DOCUMENTATION. Nothing here describes a payload; it
 *   translates the schema the API actually validates against, so "the docs say
 *   one thing and the endpoint does another" is not a state this document can
 *   reach. OpenAPI 3.1 is a superset of JSON Schema 2020-12, which is exactly
 *   what Zod 4's own `z.toJSONSchema` emits, so the translation is mechanical.
 *
 * ⚠️ INPUT AND OUTPUT ARE DIFFERENT SCHEMAS AND THE DIFFERENCE IS NOT COSMETIC.
 *   A field with `.default()` is OPTIONAL in a request and GUARANTEED in a
 *   response; a `.transform()` changes the type outright. 548 of the 671
 *   contracts differ between the two, so a document that picked one form and
 *   used it everywhere would be lying in one direction or the other about most
 *   of the surface. Request positions are converted with `io: 'input'`, response
 *   positions with `io: 'output'`, and a contract that is genuinely used in both
 *   appears twice — the second under `<Name>.Input`.
 */
import { z, type ZodType } from 'zod';
import * as contracts from '@rcln/contracts';

export type JsonSchema = Record<string, unknown>;
export type Io = 'input' | 'output';

const isZodType = (value: unknown): value is ZodType =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { safeParse?: unknown }).safeParse === 'function';

const pascalCase = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * Every schema `@rcln/contracts` exports, by the name it exports it under.
 *
 * This is what turns an anonymous object graph into `BranchDetail` in the
 * component list. A schema exported twice keeps the first name it was seen
 * under, which is stable because `Object.entries` follows declaration order.
 */
const CONTRACT_NAMES = new Map<ZodType, string>();
for (const [name, value] of Object.entries(contracts)) {
  if (isZodType(value) && !CONTRACT_NAMES.has(value)) {
    CONTRACT_NAMES.set(value, pascalCase(name));
  }
}

/** The name `@rcln/contracts` exports this schema under, if it exports it. */
export const contractNameOf = (schema: ZodType): string | null =>
  CONTRACT_NAMES.get(schema) ?? null;

const REF_PREFIX = '#/components/schemas/';

/** Where Zod's recursive/repeated subschemas end up. See `convert()`. */
const SHARED = 'Shared';

/** Convert one registry's worth of schemas in a single pass. */
function convert(ids: ReadonlyMap<ZodType, string>, io: Io): Record<string, JsonSchema> {
  const registry = z.registry<{ id: string }>();
  for (const [schema, id] of ids) registry.add(schema, { id });

  const { schemas } = z.toJSONSchema(registry, {
    io,
    /*
     * A handful of contracts use constructs JSON Schema cannot express (a
     * `z.custom`, a branded type). `any` degrades those to an unconstrained
     * value rather than throwing, which would take the whole document down over
     * one field.
     */
    unrepresentable: 'any',
    uri: (id) => `${REF_PREFIX}${id}`,
  }) as unknown as { schemas: Record<string, JsonSchema> };

  /*
   * ⚠️ ZOD PARKS RECURSIVE AND REPEATED SUBSCHEMAS IN A `__shared` BUCKET, AND
   *   THE REF IT WRITES TO THEM IS NOT A LEGAL URI. `z.json()` is self-
   *   referential, so `settingValueRequest.value` comes out pointing at
   *   `#/components/schemas/__shared#/$defs/schema3` — two fragment markers in
   *   one reference, which every OpenAPI parser rejects and which no amount of
   *   reading the document would reveal. Renaming the bucket to `Shared` and
   *   flattening the second `#` gives `#/components/schemas/Shared/$defs/schema3`,
   *   an ordinary JSON Pointer into the same place.
   */
  const repaired = JSON.parse(
    JSON.stringify(schemas).split(`${REF_PREFIX}__shared#/`).join(`${REF_PREFIX}${SHARED}/`)
  ) as Record<string, JsonSchema>;
  if (repaired['__shared'] !== undefined) {
    repaired[SHARED] = repaired['__shared'];
    delete repaired['__shared'];
  }

  // `$schema` and `$id` are meaningful to a JSON Schema document and noise in an
  // OpenAPI component. Strip them; keep everything else exactly as emitted.
  return Object.fromEntries(
    Object.entries(repaired).map(([id, body]) => {
      const rest = { ...body };
      delete rest['$schema'];
      delete rest['$id'];
      return [id, rest];
    })
  );
}

/** Every `$ref` target reachable from `root`, followed transitively. */
function referencedFrom(
  root: JsonSchema,
  pool: Record<string, JsonSchema>,
  found: Set<string>
): void {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== 'object' || node === null) return;

    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref === 'string' && ref.startsWith(REF_PREFIX)) {
      // `Shared/$defs/schema3` names the `Shared` component, not a component
      // called `Shared/$defs/schema3`.
      const name = ref.slice(REF_PREFIX.length).split('/')[0] ?? '';
      if (!found.has(name)) {
        found.add(name);
        const target = pool[name];
        if (target) visit(target);
      }
    }

    for (const value of Object.values(node)) visit(value);
  };

  visit(root);
}

/**
 * Collects the schemas a document needs and emits the component map for them.
 *
 * Used in two phases, because the names depend on the usage: which contracts end
 * up in a request position and which in a response position is only known once
 * every endpoint has been walked, and a contract used in both needs two entries
 * under two names. `add()` records; `build()` resolves.
 */
export class SchemaSpace {
  private readonly roots = new Map<ZodType, Set<Io>>();
  private readonly anonymous = new Map<ZodType, { io: Io; id: string }>();
  private components: Record<string, JsonSchema> = {};
  private inputSuffixed = new Set<string>();
  private built = false;

  /**
   * Record that `schema` is used in an `io` position, and say how to reference
   * it later. A contract schema becomes a named component; anything declared
   * inline in a route file is inlined at the use site instead, because
   * `GetBranchParams` in the component list helps nobody.
   */
  add(schema: ZodType, io: Io): void {
    if (this.built) throw new Error('SchemaSpace.add() after build()');

    const existing = this.roots.get(schema);
    if (existing) {
      existing.add(io);
      return;
    }
    this.roots.set(schema, new Set([io]));

    if (contractNameOf(schema) === null && !this.anonymous.has(schema)) {
      this.anonymous.set(schema, { io, id: `Anonymous${String(this.anonymous.size)}` });
    }
  }

  /** Resolve names, convert everything, and drop components nothing points at. */
  build(): Record<string, JsonSchema> {
    if (this.built) return this.components;
    this.built = true;

    /*
     * Every contract is registered, not only the roots: a root's nested pieces
     * have to be registered too or Zod inlines them instead of emitting a `$ref`,
     * and the component list is what makes a 289-endpoint document navigable.
     * The unreferenced ones are pruned at the end.
     */
    const allContracts = new Map<ZodType, string>(CONTRACT_NAMES);
    for (const [schema, { id }] of this.anonymous) allContracts.set(schema, id);

    const outputPool = convert(allContracts, 'output');
    const inputPoolPlain = convert(allContracts, 'input');

    // Which named components each side actually needs, following refs.
    const usedOutput = new Set<string>();
    const usedInput = new Set<string>();
    for (const [schema, ios] of this.roots) {
      const name = contractNameOf(schema) ?? this.anonymous.get(schema)?.id;
      if (name === undefined) continue;
      if (ios.has('output')) {
        usedOutput.add(name);
        referencedFrom(outputPool[name] ?? {}, outputPool, usedOutput);
      }
      if (ios.has('input')) {
        usedInput.add(name);
        referencedFrom(inputPoolPlain[name] ?? {}, inputPoolPlain, usedInput);
      }
    }

    /*
     * A name needed on both sides whose two forms differ has to appear twice.
     * The response form keeps the plain name — it is the one a reader meets most
     * — and the request form is re-converted under `<Name>.Input` so that its
     * own nested refs point at the input forms too.
     */
    const collides = [...usedInput].filter(
      (name) =>
        usedOutput.has(name) &&
        JSON.stringify(inputPoolPlain[name]) !== JSON.stringify(outputPool[name])
    );
    this.inputSuffixed = new Set(collides);

    const inputIds = new Map<ZodType, string>();
    for (const [schema, name] of allContracts) {
      inputIds.set(schema, this.inputSuffixed.has(name) ? `${name}.Input` : name);
    }
    const inputPool = convert(inputIds, 'input');

    const merged: Record<string, JsonSchema> = {};
    for (const name of usedOutput) {
      const body = outputPool[name];
      if (body) merged[name] = body;
    }
    for (const name of usedInput) {
      const id = this.inputSuffixed.has(name) ? `${name}.Input` : name;
      const body = inputPool[id];
      if (body) merged[id] = body;
    }

    // Anonymous roots are inlined at the use site, never listed as components.
    for (const { id } of this.anonymous.values()) {
      delete merged[id];
      delete merged[`${id}.Input`];
    }

    this.components = Object.fromEntries(
      Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))
    );
    this.inputPool = inputPool;
    this.outputPool = outputPool;
    return this.components;
  }

  private inputPool: Record<string, JsonSchema> = {};
  private outputPool: Record<string, JsonSchema> = {};

  /**
   * How to write `schema` into the document — a `$ref` for a contract, the
   * converted body for anything declared inline in a route file.
   */
  refTo(schema: ZodType, io: Io): JsonSchema {
    if (!this.built) throw new Error('SchemaSpace.refTo() before build()');

    const name = contractNameOf(schema);
    if (name !== null) {
      const id = io === 'input' && this.inputSuffixed.has(name) ? `${name}.Input` : name;
      return { $ref: `${REF_PREFIX}${id}` };
    }

    const anon = this.anonymous.get(schema);
    if (anon === undefined) return {};
    const pool = io === 'input' ? this.inputPool : this.outputPool;
    return pool[anon.id] ?? {};
  }
}
