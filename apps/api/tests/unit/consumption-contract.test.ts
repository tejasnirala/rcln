/**
 * The consumption contracts, as assertions (PI-9).
 *
 * ⚠️ WHAT THIS SUITE IS REALLY POLICING IS AN ABSENCE. Two fields are
 *   deliberately NOT on the request shapes, and both absences are controls
 *   rather than omissions:
 *
 *     `isOverride`   whether a line departs from the template is arithmetic the
 *                    SERVER does over two numbers it already holds. A
 *                    client-supplied flag is a control only the honest client
 *                    applies — which is exactly what PI-8.11's dispensing
 *                    CRITICAL turned out to be.
 *     `patientId`    taken from the encounter, never from the body. A body that
 *                    could name a different patient can file somebody else's
 *                    implant on your record.
 *
 *   A schema test cannot prove a service reads them correctly; what it CAN do is
 *   fail the day somebody adds either field back, which is the change that would
 *   quietly undo both.
 *
 * No database, no Prisma, no PHI.
 */
import {
  amendConsumptionRequest,
  consumptionAnchorKind,
  correctConsumptionRequest,
  createConsumptionTemplateRequest,
  recordConsumptionRequest,
  updateConsumptionTemplateRequest,
} from '@rcln/contracts';

const ENCOUNTER = '11111111-1111-4111-8111-111111111111';
const PROCEDURE = '22222222-2222-4222-8222-222222222222';
const LOCATION = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const UNIT = '55555555-5555-4555-8555-555555555555';
const ITEM = '66666666-6666-4666-8666-666666666666';

const line = { productId: PRODUCT, quantity: '2', unitId: UNIT };

describe('recording what was used', () => {
  it('accepts a consumption anchored to a procedure', () => {
    const parsed = recordConsumptionRequest.safeParse({
      encounterId: ENCOUNTER,
      encounterProcedureId: PROCEDURE,
      locationId: LOCATION,
      lines: [line],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a consumption filed against the visit itself', () => {
    const parsed = recordConsumptionRequest.safeParse({
      anchorKind: 'ENCOUNTER',
      encounterId: ENCOUNTER,
      locationId: LOCATION,
      lines: [line],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a procedure anchor with no procedure', () => {
    const parsed = recordConsumptionRequest.safeParse({
      anchorKind: 'ENCOUNTER_PROCEDURE',
      encounterId: ENCOUNTER,
      locationId: LOCATION,
      lines: [line],
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a visit anchor that names a procedure anyway', () => {
    const parsed = recordConsumptionRequest.safeParse({
      anchorKind: 'ENCOUNTER',
      encounterId: ENCOUNTER,
      encounterProcedureId: PROCEDURE,
      locationId: LOCATION,
      lines: [line],
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a record with no lines', () => {
    const parsed = recordConsumptionRequest.safeParse({
      anchorKind: 'ENCOUNTER',
      encounterId: ENCOUNTER,
      locationId: LOCATION,
      lines: [],
    });
    expect(parsed.success).toBe(false);
  });

  /**
   * ⚠️ "USED NONE OF IT" IS A LINE NOBODY SHOULD HAVE WRITTEN, not a
   *   zero-quantity ledger leg. The panel omits an untouched line; the contract
   *   refuses one sent anyway, and the CHECK constraint refuses it again.
   */
  it('refuses a quantity of zero or below', () => {
    for (const quantity of ['0', '-1']) {
      const parsed = recordConsumptionRequest.safeParse({
        anchorKind: 'ENCOUNTER',
        encounterId: ENCOUNTER,
        locationId: LOCATION,
        lines: [{ ...line, quantity }],
      });
      expect(parsed.success).toBe(false);
    }
  });

  /** ⚠️ THE ABSENCE THAT IS A CONTROL. See the file header. */
  it('drops a client-supplied variance flag rather than honouring it', () => {
    const parsed = recordConsumptionRequest.safeParse({
      anchorKind: 'ENCOUNTER',
      encounterId: ENCOUNTER,
      locationId: LOCATION,
      lines: [{ ...line, isOverride: false }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'isOverride' in parsed.data.lines[0]!).toBe(false);
  });

  /** ⚠️ THE OTHER ABSENCE. The patient comes from the encounter. */
  it('drops a client-supplied patient rather than honouring it', () => {
    const parsed = recordConsumptionRequest.safeParse({
      anchorKind: 'ENCOUNTER',
      encounterId: ENCOUNTER,
      locationId: LOCATION,
      patientId: '77777777-7777-4777-8777-777777777777',
      lines: [line],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'patientId' in parsed.data).toBe(false);
  });

  /**
   * ⚠️ ONLY THE TWO BUILT ANCHORS ARE ON THE WIRE. `LAB_ORDER` and
   *   `IMAGING_STUDY` are members of the DATABASE enum so those phases need no
   *   enum migration, and the CHECK constraint refuses them — so accepting them
   *   here would be an API promising something the database declines.
   */
  it('refuses an anchor kind that has no table behind it', () => {
    expect(consumptionAnchorKind.safeParse('LAB_ORDER').success).toBe(false);
    expect(consumptionAnchorKind.safeParse('IMAGING_STUDY').success).toBe(false);
    expect(consumptionAnchorKind.safeParse('ENCOUNTER').success).toBe(true);
  });
});

describe('amending and correcting', () => {
  it('requires a reason for an amendment', () => {
    expect(amendConsumptionRequest.safeParse({ lines: [line], reason: '' }).success).toBe(false);
    expect(
      amendConsumptionRequest.safeParse({ lines: [line], reason: 'Miscounted.' }).success
    ).toBe(true);
  });

  it('requires a reason for a correction', () => {
    expect(
      correctConsumptionRequest.safeParse({
        kind: 'CONSUMPTION_REVERSAL',
        lines: [line],
        reason: '',
      }).success
    ).toBe(false);
  });

  /**
   * ⚠️ A CORRECTION IS ONE OF TWO DIRECTIONS AND NEVER THE ORDINARY RECORD.
   *   `CONSUMPTION` arrives through `POST /records`; letting it through here
   *   would give the correction route a second door onto the recording path,
   *   with a `correctsConsumptionId` the CHECK constraint then refuses.
   */
  it('refuses an ordinary consumption as a correction kind', () => {
    expect(
      correctConsumptionRequest.safeParse({
        kind: 'CONSUMPTION',
        lines: [line],
        reason: 'Nope.',
      }).success
    ).toBe(false);
  });

  /** ⚠️ POSITIVE IN BOTH DIRECTIONS — the sign lives in `kind`. */
  it('refuses a negative quantity on a reversal', () => {
    expect(
      correctConsumptionRequest.safeParse({
        kind: 'CONSUMPTION_REVERSAL',
        lines: [{ ...line, quantity: '-1' }],
        reason: 'One went back.',
      }).success
    ).toBe(false);
  });
});

describe('templates', () => {
  it('starts empty and in draft', () => {
    const parsed = createConsumptionTemplateRequest.safeParse({
      itemId: ITEM,
      name: 'Root canal tray',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.status).toBe('DRAFT');
    expect(parsed.success && parsed.data.lines).toEqual([]);
  });

  /**
   * ⚠️ "LEAVE THE LINES ALONE" AND "THE TEMPLATE NOW LISTS NOTHING" ARE
   *   DIFFERENT INTENTIONS, and the update shape keeps them apart. A
   *   `.default([])` here would empty a template every time somebody renamed
   *   one.
   */
  it('distinguishes an omitted line set from an empty one', () => {
    const renamed = updateConsumptionTemplateRequest.safeParse({ name: 'Renamed' });
    expect(renamed.success).toBe(true);
    expect(renamed.success && 'lines' in renamed.data).toBe(false);

    const emptied = updateConsumptionTemplateRequest.safeParse({ lines: [] });
    expect(emptied.success).toBe(true);
    expect(emptied.success && emptied.data.lines).toEqual([]);
  });

  it('refuses a template line asking for nothing', () => {
    expect(
      createConsumptionTemplateRequest.safeParse({
        itemId: ITEM,
        name: 'Tray',
        lines: [{ productId: PRODUCT, quantity: '0', unitId: UNIT }],
      }).success
    ).toBe(false);
  });
});
