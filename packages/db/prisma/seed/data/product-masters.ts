/**
 * The STRUCTURAL product catalogue: units, the conversions between them,
 * categories and storage profiles. Platform rows, seeded by `rcln_owner`.
 *
 * ⚠️ THERE IS NO MEDICINE DATA HERE, AND THAT IS A DECISION, NOT AN OVERSIGHT
 *   (OD-4). A product catalogue with real drug data is either LICENSED from a
 *   data provider or BUILT from public national registers — both are business
 *   and legal decisions with per-country redistribution terms, and neither has
 *   been taken. So the platform ships the structure and clinics enter their own
 *   products, with the import machinery designed in so a licensed dataset can be
 *   loaded later.
 *
 * ⚠️⚠️ WHAT MUST NEVER HAPPEN: A MODEL GENERATING THIS DATA FROM MEMORY.
 *   A hallucinated strength, composition or schedule in a dispensing system is a
 *   patient-safety defect, and it will look completely plausible to everyone who
 *   reviews it — that is precisely what makes it dangerous. No agent may
 *   populate `products`, `active_ingredients` or `compositions` from its own
 *   knowledge under any circumstances. Units, categories and storage ranges are
 *   different in kind: they are structural facts about measurement and
 *   refrigeration, not clinical claims about a drug.
 */

export interface SeedUnit {
  code: string;
  name: string;
  symbol: string;
  unitClass: 'COUNT' | 'VOLUME' | 'MASS' | 'LENGTH' | 'AREA';
  /** Exactly one per class. Only the platform may set it — see the CHECK. */
  isBase?: boolean;
}

/**
 * ⚠️ THE `COUNT` UNITS DELIBERATELY DO NOT CONVERT INTO ONE ANOTHER.
 *   A strip is ten tablets FOR ONE PRODUCT and fifteen for the next, so stating
 *   it here would assert something false for half the catalogue. Pack sizes are
 *   `product_packagings`, which is per product for exactly this reason. The only
 *   COUNT conversions below are the two that are true by definition — a dozen is
 *   twelve, a pair is two.
 */
export const UNITS: SeedUnit[] = [
  // -- count ---------------------------------------------------------------
  { code: 'PIECE', name: 'Piece', symbol: 'pc', unitClass: 'COUNT', isBase: true },
  { code: 'TAB', name: 'Tablet', symbol: 'tab', unitClass: 'COUNT' },
  { code: 'CAP', name: 'Capsule', symbol: 'cap', unitClass: 'COUNT' },
  { code: 'VIAL', name: 'Vial', symbol: 'vial', unitClass: 'COUNT' },
  { code: 'AMPOULE', name: 'Ampoule', symbol: 'amp', unitClass: 'COUNT' },
  { code: 'SACHET', name: 'Sachet', symbol: 'sachet', unitClass: 'COUNT' },
  { code: 'DOSE', name: 'Dose', symbol: 'dose', unitClass: 'COUNT' },
  { code: 'DROP', name: 'Drop', symbol: 'drop', unitClass: 'COUNT' },
  { code: 'PAIR', name: 'Pair', symbol: 'pair', unitClass: 'COUNT' },
  { code: 'DOZEN', name: 'Dozen', symbol: 'dz', unitClass: 'COUNT' },
  // Packaging levels. Present as units so a ladder can name them; what one
  // CONTAINS is stated per product.
  { code: 'STRIP', name: 'Strip', symbol: 'strip', unitClass: 'COUNT' },
  { code: 'BLISTER', name: 'Blister', symbol: 'blister', unitClass: 'COUNT' },
  { code: 'BOX', name: 'Box', symbol: 'box', unitClass: 'COUNT' },
  { code: 'CARTON', name: 'Carton', symbol: 'carton', unitClass: 'COUNT' },
  { code: 'PACK', name: 'Pack', symbol: 'pack', unitClass: 'COUNT' },
  { code: 'BOTTLE', name: 'Bottle', symbol: 'bottle', unitClass: 'COUNT' },
  { code: 'TUBE', name: 'Tube', symbol: 'tube', unitClass: 'COUNT' },
  { code: 'JAR', name: 'Jar', symbol: 'jar', unitClass: 'COUNT' },
  { code: 'KIT', name: 'Kit', symbol: 'kit', unitClass: 'COUNT' },
  { code: 'ROLL', name: 'Roll', symbol: 'roll', unitClass: 'COUNT' },
  { code: 'SYRINGE', name: 'Syringe', symbol: 'syringe', unitClass: 'COUNT' },
  { code: 'CASE', name: 'Case', symbol: 'case', unitClass: 'COUNT' },

  // -- volume --------------------------------------------------------------
  // Base is the MILLILITRE rather than the litre: clinical volumes are small,
  // and a base unit larger than the doses measured against it puts every ledger
  // quantity into fractions for no benefit.
  { code: 'ML', name: 'Millilitre', symbol: 'mL', unitClass: 'VOLUME', isBase: true },
  { code: 'L', name: 'Litre', symbol: 'L', unitClass: 'VOLUME' },
  { code: 'MCL', name: 'Microlitre', symbol: 'µL', unitClass: 'VOLUME' },

  // -- mass ----------------------------------------------------------------
  // Base is the MILLIGRAM, for the same reason: strengths are written in mg.
  { code: 'MG', name: 'Milligram', symbol: 'mg', unitClass: 'MASS', isBase: true },
  { code: 'G', name: 'Gram', symbol: 'g', unitClass: 'MASS' },
  { code: 'KG', name: 'Kilogram', symbol: 'kg', unitClass: 'MASS' },
  { code: 'MCG', name: 'Microgram', symbol: 'µg', unitClass: 'MASS' },
  /*
   * ⚠️ `IU` IS IN THE MASS CLASS AND IS NOT CONVERTIBLE TO MILLIGRAMS, AND THAT
   *   IS CORRECT. An International Unit is a measure of biological ACTIVITY: the
   *   mg equivalent of one IU differs per substance (insulin and vitamin D do
   *   not agree), so there is no conversion row and `conversionFactor` will
   *   refuse to invent one. It sits in MASS because that is where a strength
   *   belongs; the absence of an edge is what keeps it honest.
   */
  { code: 'IU', name: 'International Unit', symbol: 'IU', unitClass: 'MASS' },

  // -- length --------------------------------------------------------------
  { code: 'MM', name: 'Millimetre', symbol: 'mm', unitClass: 'LENGTH', isBase: true },
  { code: 'CM', name: 'Centimetre', symbol: 'cm', unitClass: 'LENGTH' },
  { code: 'M', name: 'Metre', symbol: 'm', unitClass: 'LENGTH' },

  // -- area ----------------------------------------------------------------
  { code: 'SQCM', name: 'Square centimetre', symbol: 'cm²', unitClass: 'AREA', isBase: true },
  { code: 'SQM', name: 'Square metre', symbol: 'm²', unitClass: 'AREA' },
];

export interface SeedConversion {
  /** `from` x numerator / denominator = `to`. Integers, never a decimal factor. */
  from: string;
  to: string;
  numerator: number;
  denominator?: number;
}

/**
 * Every one of these is exact and true by definition of the units involved.
 *
 * ⚠️ NOTHING APPROXIMATE BELONGS HERE. An imperial conversion (1 fl oz =
 *   29.5735 mL) is not exact in any integer ratio a clinic would recognise, and
 *   a rounded one silently corrupts every quantity that passes through it. If a
 *   country pack needs imperial units, it states the ratio the regulator
 *   publishes, in full precision, and it is reviewed.
 */
export const UNIT_CONVERSIONS: SeedConversion[] = [
  { from: 'DOZEN', to: 'PIECE', numerator: 12 },
  { from: 'PAIR', to: 'PIECE', numerator: 2 },

  { from: 'L', to: 'ML', numerator: 1000 },
  { from: 'ML', to: 'MCL', numerator: 1000 },

  { from: 'G', to: 'MG', numerator: 1000 },
  { from: 'KG', to: 'G', numerator: 1000 },
  { from: 'MG', to: 'MCG', numerator: 1000 },

  { from: 'CM', to: 'MM', numerator: 10 },
  { from: 'M', to: 'CM', numerator: 100 },

  { from: 'SQM', to: 'SQCM', numerator: 10_000 },
];

export interface SeedCategory {
  code: string;
  name: string;
  parent?: string;
  description?: string;
}

/**
 * A shallow, structural tree. Deliberately NOT a therapeutic classification.
 *
 * ⚠️ THIS IS NOT ATC, AND MUST NOT BE MISTAKEN FOR IT. A real therapeutic
 *   classification is a maintained standard with clinical consequences, and
 *   inventing one here would produce something that looks authoritative and is
 *   not. These are STOREROOM categories — how a clinic finds a thing on a shelf
 *   and in a picker. A clinic that wants finer detail adds its own children;
 *   that is what tenant extension is for.
 */
export const CATEGORIES: SeedCategory[] = [
  { code: 'MEDICINES', name: 'Medicines', description: 'Anything administered to a patient.' },
  { code: 'MED_ORAL', name: 'Oral medicines', parent: 'MEDICINES' },
  { code: 'MED_INJECTABLE', name: 'Injectables', parent: 'MEDICINES' },
  { code: 'MED_TOPICAL', name: 'Topical preparations', parent: 'MEDICINES' },
  { code: 'MED_OPHTHALMIC', name: 'Eye, ear and nasal preparations', parent: 'MEDICINES' },
  { code: 'MED_INHALED', name: 'Inhaled preparations', parent: 'MEDICINES' },
  { code: 'MED_IV_FLUIDS', name: 'IV fluids', parent: 'MEDICINES' },
  { code: 'MED_VACCINES', name: 'Vaccines', parent: 'MEDICINES' },

  { code: 'CONSUMABLES', name: 'Consumables', description: 'Used up in the course of care.' },
  { code: 'CON_DRESSINGS', name: 'Dressings and bandages', parent: 'CONSUMABLES' },
  { code: 'CON_SYRINGES', name: 'Syringes and needles', parent: 'CONSUMABLES' },
  { code: 'CON_GLOVES', name: 'Gloves', parent: 'CONSUMABLES' },
  { code: 'CON_PPE', name: 'Protective equipment', parent: 'CONSUMABLES' },
  { code: 'CON_SUTURES', name: 'Sutures', parent: 'CONSUMABLES' },
  { code: 'CON_CATHETERS', name: 'Catheters and tubing', parent: 'CONSUMABLES' },
  { code: 'CON_ANTISEPTICS', name: 'Antiseptics and disinfectants', parent: 'CONSUMABLES' },

  { code: 'DENTAL', name: 'Dental materials' },
  { code: 'DEN_RESTORATIVE', name: 'Restorative materials', parent: 'DENTAL' },
  { code: 'DEN_ENDODONTIC', name: 'Endodontic materials', parent: 'DENTAL' },
  { code: 'DEN_IMPRESSION', name: 'Impression materials', parent: 'DENTAL' },
  { code: 'DEN_PROSTHETIC', name: 'Prosthetic materials', parent: 'DENTAL' },

  { code: 'LABORATORY', name: 'Laboratory' },
  { code: 'LAB_REAGENTS', name: 'Reagents', parent: 'LABORATORY' },
  { code: 'LAB_KITS', name: 'Diagnostic kits', parent: 'LABORATORY' },
  { code: 'LAB_CONSUMABLES', name: 'Laboratory consumables', parent: 'LABORATORY' },

  { code: 'DEVICES', name: 'Devices and implants' },
  { code: 'DEV_IMPLANTS', name: 'Implants', parent: 'DEVICES' },
  { code: 'DEV_INSTRUMENTS', name: 'Instruments', parent: 'DEVICES' },
  { code: 'DEV_MONITORING', name: 'Monitoring devices', parent: 'DEVICES' },

  { code: 'VETERINARY', name: 'Veterinary' },
  { code: 'VET_MEDICINES', name: 'Veterinary medicines', parent: 'VETERINARY' },
  { code: 'VET_CONSUMABLES', name: 'Veterinary consumables', parent: 'VETERINARY' },
];

export interface SeedStorageProfile {
  code: string;
  name: string;
  minTemperatureC?: string;
  maxTemperatureC?: string;
  minHumidityPct?: number;
  maxHumidityPct?: number;
  lightSensitivity?: 'NONE' | 'PROTECT_FROM_LIGHT' | 'PROTECT_FROM_DIRECT_SUNLIGHT';
  requiresControlledAccess?: boolean;
  hazardClass?: string;
  handlingNotes?: string;
}

/**
 * The storage bands a clinic actually has somewhere to put things in.
 *
 * Temperatures are the widely-published pharmaceutical storage bands. They are
 * DEFAULTS a clinic can edit and are not a regulatory assertion — a product's
 * real requirement comes from its own labelling, and from PI-5 where a
 * jurisdiction mandates one.
 */
export const STORAGE_PROFILES: SeedStorageProfile[] = [
  {
    code: 'AMBIENT',
    name: 'Room temperature',
    minTemperatureC: '15',
    maxTemperatureC: '25',
    maxHumidityPct: 60,
  },
  {
    code: 'COOL',
    name: 'Cool storage',
    minTemperatureC: '8',
    maxTemperatureC: '15',
  },
  {
    code: 'COLD_CHAIN',
    name: 'Refrigerated (cold chain)',
    minTemperatureC: '2',
    maxTemperatureC: '8',
    handlingNotes:
      'Cold chain. Do not freeze. Record an excursion whenever the range is left, however briefly.',
  },
  {
    code: 'FROZEN',
    name: 'Frozen',
    minTemperatureC: '-25',
    maxTemperatureC: '-15',
  },
  {
    code: 'ULTRA_COLD',
    name: 'Ultra-cold',
    minTemperatureC: '-80',
    maxTemperatureC: '-60',
  },
  {
    code: 'LIGHT_SENSITIVE',
    name: 'Protect from light',
    minTemperatureC: '15',
    maxTemperatureC: '25',
    lightSensitivity: 'PROTECT_FROM_LIGHT',
    handlingNotes: 'Keep in the original carton until use.',
  },
  {
    /*
     * ⚠️ THE FLAG IS DESCRIPTIVE AND IS NOT AN ACCESS CONTROL. It says the
     *   cabinet should be locked; it does not decide who may dispense from it.
     *   That is a permission (`pharmacy.dispense.*`) and, from PI-6, a
     *   regulatory rule. Nothing may branch authorization on this column.
     */
    code: 'CONTROLLED_ACCESS',
    name: 'Controlled cabinet',
    minTemperatureC: '15',
    maxTemperatureC: '25',
    requiresControlledAccess: true,
    handlingNotes: 'Locked storage with a signed register, where the jurisdiction requires one.',
  },
  {
    code: 'FLAMMABLE',
    name: 'Flammable store',
    minTemperatureC: '15',
    maxTemperatureC: '25',
    hazardClass: 'Flammable liquid',
    handlingNotes: 'Away from ignition sources, in a ventilated cabinet.',
  },
  {
    code: 'CYTOTOXIC',
    name: 'Cytotoxic',
    minTemperatureC: '15',
    maxTemperatureC: '25',
    requiresControlledAccess: true,
    hazardClass: 'Cytotoxic',
    handlingNotes: 'Segregated storage. Spill kit within reach. Dispose of as cytotoxic waste.',
  },
];
