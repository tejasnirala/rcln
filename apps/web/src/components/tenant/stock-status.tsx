/**
 * How stock is spoken about on screen, in one place.
 *
 * ── THE SIGNATURE ELEMENT OF THIS SECTION: THE BUCKET BAR ───────────────────
 * A lot's quantity is NEVER ONE NUMBER, and that is the whole point of
 * PI-ADR-013. Ninety available at the main pharmacy and thirty quarantined in
 * the fridge is one lot in two conditions, and a single "Qty" column can express
 * neither. So a lot's holding is drawn as one thin segmented rule, proportional,
 * with the words beside it.
 *
 * It is the one visually distinctive thing in this section, and everything
 * around it is deliberately quiet — a table of numbers with one bar that says
 * what the numbers mean.
 *
 * ⚠️ THE WORDS ARE NOT OPTIONAL DECORATION ON THE BAR. Colour alone would fail
 *   WCAG 1.4.1, and it would fail the more practical test too: "amber" does not
 *   tell a pharmacist whether stock is quarantined, expired or damaged, and
 *   those have three different next actions. The bar shows the PROPORTION; the
 *   legend says WHAT.
 *
 * ⚠️ AND ONLY `AVAILABLE` IS DISPENSABLE. Everything else is visible, countable
 *   and valued but not allocatable, which is exactly why quarantine works. The
 *   bar renders available first and everything else after it, so "how much can I
 *   actually give out" is the leftmost segment on every row.
 */
import { readableQuantity, type BatchStatus, type StockStatus } from '@rcln/contracts';

/**
 * Statuses in the order they are drawn, and the words used for them.
 *
 * Sentence case, and the clinic's vocabulary rather than the column's: a
 * pharmacist says "on hold", not "QUARANTINED".
 */
export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  AVAILABLE: 'Available',
  RESERVED: 'Reserved',
  QUARANTINED: 'On hold',
  BLOCKED: 'Blocked',
  EXPIRED: 'Expired',
  DAMAGED: 'Damaged',
  RECALLED: 'Recalled',
  DISPOSED: 'Disposed',
  IN_TRANSIT: 'In transit',
};

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  ACTIVE: 'Active',
  QUARANTINED: 'On hold',
  EXPIRED: 'Expired',
  RECALLED: 'Recalled',
  DAMAGED: 'Damaged',
  DISPOSED: 'Disposed',
};

/** Drawing order. Available leads; the rest follow in decreasing usefulness. */
const ORDER: StockStatus[] = [
  'AVAILABLE',
  'RESERVED',
  'IN_TRANSIT',
  'QUARANTINED',
  'BLOCKED',
  'EXPIRED',
  'DAMAGED',
  'RECALLED',
  'DISPOSED',
];

/*
 * ⚠️ TWO TONES, NOT NINE. A nine-colour key is a legend nobody learns, and it
 *   would compete with the one accent this whole application uses. The bar says
 *   only "dispensable" against "held back"; the legend beside it says which kind
 *   of held back, in words. That is the honest amount of information a 4px rule
 *   can carry.
 */
const TONE: Record<StockStatus, string> = {
  AVAILABLE: 'bg-drape',
  RESERVED: 'bg-drape/45',
  IN_TRANSIT: 'bg-drape/45',
  QUARANTINED: 'bg-signal/70',
  BLOCKED: 'bg-signal/70',
  EXPIRED: 'bg-signal/70',
  DAMAGED: 'bg-signal/70',
  RECALLED: 'bg-signal/70',
  DISPOSED: 'bg-rule',
};

export interface Bucket {
  status: StockStatus;
  quantity: string;
}

/**
 * Sum a set of buckets without going through a float.
 *
 * ⚠️ THE QUANTITIES ARRIVE AS STRINGS BECAUSE THEY ARE `Decimal(18,6)` AND A
 *   JSON NUMBER IS A DOUBLE. Here they are only being turned into segment
 *   widths, so `Number` is safe and is used deliberately — a percentage does not
 *   need eighteen digits. Nothing in this file is arithmetic anyone counts on;
 *   the totals a person reads are rendered from the strings themselves.
 */
function widths(buckets: Bucket[]): { status: StockStatus; percent: number; quantity: string }[] {
  const present = ORDER.map((status) => buckets.find((b) => b.status === status)).filter(
    (b): b is Bucket => b !== undefined && Number(b.quantity) > 0
  );

  const total = present.reduce((sum, b) => sum + Number(b.quantity), 0);
  if (total === 0) return [];

  return present.map((b) => ({
    status: b.status,
    percent: (Number(b.quantity) / total) * 100,
    quantity: b.quantity,
  }));
}

/**
 * Trim the ledger's six decimal places down to what a person reads.
 *
 * ⚠️ RE-EXPORTED FROM `@rcln/contracts`, NOT DEFINED HERE, AND IT MOVED FOR ONE
 *   REASON: it shipped a bug that rendered `100` as `1` on every stock screen,
 *   and `apps/web` has no test suite in which that could have been caught. It
 *   now sits beside `decimalString` — the wire format it is the display inverse
 *   of — where `apps/api`'s unit suite covers it.
 */
export { readableQuantity as readable } from '@rcln/contracts';

/**
 * One lot's holding, drawn.
 *
 * `unit` is the product's base unit symbol — every quantity in the programme is
 * denominated in it, and showing a number without it is showing a number that
 * means nothing.
 */
export function BucketBar({
  buckets,
  unit,
  label,
}: {
  buckets: Bucket[];
  unit: string;
  label: string;
}) {
  const segments = widths(buckets);

  if (segments.length === 0) {
    return <p className="text-muted text-[0.75rem]">Nothing on hand</p>;
  }

  const description = segments
    .map(
      (s) => `${readableQuantity(s.quantity)} ${unit} ${STOCK_STATUS_LABEL[s.status].toLowerCase()}`
    )
    .join(', ');

  return (
    <div>
      {/*
        One accessible sentence for the whole bar, and the segments hidden from
        the reading order. Nine `<div>`s each announcing a percentage is noise;
        "90 tab available, 30 tab on hold" is the fact.
      */}
      <div
        className="bg-rule/40 flex h-1 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`${label}: ${description}`}
      >
        {segments.map((segment) => (
          <div
            key={segment.status}
            className={TONE[segment.status]}
            style={{ width: `${segment.percent}%` }}
          />
        ))}
      </div>

      <p aria-hidden className="text-muted mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.75rem]">
        {segments.map((segment) => (
          <span key={segment.status}>
            <span className="text-ink font-mono">{readableQuantity(segment.quantity)}</span>{' '}
            {STOCK_STATUS_LABEL[segment.status].toLowerCase()}
          </span>
        ))}
      </p>
    </div>
  );
}

/**
 * How close a lot is to its expiry, in words a person can act on.
 *
 * ⚠️ THE NUMBER COMES FROM THE SERVER, COMPUTED IN THE BRANCH'S TIMEZONE. It is
 *   never recomputed here from `expiresOn` and `new Date()`: the browser is in
 *   whatever zone the user's laptop is set to, which is not the clinic's, and a
 *   lot would read "expires today" a day early for half the world. Invariant 6.
 */
export function expiryPhrase(daysRemaining: number): string {
  if (daysRemaining < 0) {
    const days = Math.abs(daysRemaining);
    return days === 1 ? 'Expired yesterday' : `Expired ${String(days)} days ago`;
  }
  if (daysRemaining === 0) return 'Expires today';
  if (daysRemaining === 1) return 'Expires tomorrow';
  return `Expires in ${String(daysRemaining)} days`;
}

/**
 * A transfer's progress, drawn with the SAME rule the bucket bar uses (PI-3).
 *
 * ⚠️ THE SECTION'S SIGNATURE ELEMENT IS EXTENDED, NOT JOINED BY A SECOND ONE.
 *   The bucket bar already says "this quantity is not one number" in a 4px rule;
 *   a transfer is the same sentence about time rather than condition — some of
 *   it has arrived, some is still on the van. Inventing a second visual device
 *   for the second idea would leave the section with two things competing to be
 *   the memorable one, and the whole reason the bar works is that everything
 *   around it is quiet.
 *
 * ⚠️ AND THE OUTSTANDING SEGMENT USES THE SAME `drape/45` AS `RESERVED` AND
 *   `IN_TRANSIT` DO ABOVE. That is not a coincidence being reused: in every case
 *   the half-tone means "this is real stock the clinic owns and cannot dispense
 *   today", which is exactly what stock on a van is.
 */
export function TransferProgress({
  sent,
  received,
  unit,
  label,
}: {
  sent: string;
  received: string;
  unit: string;
  label: string;
}) {
  const total = Number(sent);
  const arrived = Number(received);
  const percent = total <= 0 ? 0 : Math.min(100, (arrived / total) * 100);
  const outstanding = readableQuantity(String(Math.max(0, total - arrived)));

  return (
    <div>
      <div
        className="bg-rule/40 flex h-1 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={
          percent >= 100
            ? `${label}: all ${readableQuantity(sent)} ${unit} received`
            : `${label}: ${readableQuantity(received)} of ${readableQuantity(sent)} ${unit} received, ${outstanding} ${unit} outstanding`
        }
      >
        <div className="bg-drape" style={{ width: `${String(percent)}%` }} />
        <div className="bg-drape/45" style={{ width: `${String(100 - percent)}%` }} />
      </div>

      <p aria-hidden className="text-muted mt-1.5 flex flex-wrap gap-x-3 text-[0.75rem]">
        <span>
          <span className="text-ink font-mono">{readableQuantity(received)}</span> received
        </span>
        {percent < 100 ? (
          <span>
            <span className="text-ink font-mono">{outstanding}</span> outstanding
          </span>
        ) : null}
      </p>
    </div>
  );
}
