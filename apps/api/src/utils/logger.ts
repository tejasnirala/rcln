import pino from 'pino';
import { config } from '../config/index.js';

/**
 * pino, not winston: winston's async transports drop buffered lines on crash,
 * which is exactly when you need them. Redaction is not optional here — this is
 * a healthcare system and PII must never reach the log sink.
 */
export const logger = pino({
  level: config.log.level,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.newPassword',
      'req.body.currentPassword',
      'req.body.token',
      'req.body.refreshToken',
      'req.body.code',
      'req.body.phone',
      'req.body.email',
      // Public demo form: a person's name, and free text they may put anything
      // into. Not PHI by design, but not something to keep in log storage.
      'req.body.contactName',
      'req.body.message',
      // The animal's owner (PI-11). A person's name and mobile number, on the
      // animal-profile body. Defensive in the same way every entry above it is:
      // `pino-http` runs with the default serializers, which log method, url and
      // headers and never `req.body` at all — so nothing reaches this today, and
      // the day a serializer changes is not the day to start writing the list.
      'req.body.guardianName',
      'req.body.guardianPhone',
      // Where a parcel is going, and who signs for it (PI-12). ⚠️ THE MOST
      // SENSITIVE BODY FIELDS THIS PRODUCT HAS EVER CARRIED — a named person's
      // home address beside the medicine being sent to it, which is a
      // physical-safety fact as much as a clinical one. Nested one level down,
      // so each needs its own literal path for the reason spelled out below.
      // Same defensive argument as the two lines above: nothing reaches this
      // today, and the day a serializer changes is not the day to start.
      'req.body.address.recipientName',
      'req.body.address.recipientPhone',
      'req.body.address.addressLine1',
      'req.body.address.addressLine2',
      'req.body.address.city',
      'req.body.address.state',
      'req.body.address.pincode',
      'req.body.receivedByName',
      // ⚠️ AND THE FREE TEXT BESIDE IT. `online_orders.notes` is marked PHI in
      // the schema — "anything the person taking the order wrote down" — and it
      // reaches three routes. A town and a name is a narrower disclosure than a
      // full address and it is the same CLASS of fact, which is why `city` and
      // `state` are above rather than left out beside `pincode`.
      'req.body.notes',
      /* Why a named person's medicine could not be delivered to their house —
       * the schema calls `failure_reason` PHI-adjacent, and its sibling `notes`
       * was redacted while this was not. (PI-24 review.) */
      'req.body.reason',
      // Registration nests the owner's credentials one level down. pino's redact
      // paths are literal, not recursive: 'req.body.password' does NOT cover
      // 'req.body.owner.password', so the whole signup payload would otherwise
      // be logged in clear. Every nested secret needs its own path.
      'req.body.owner.password',
      'req.body.owner.email',
      'req.body.owner.phone',
      'req.body.owner.fullName',
      'req.body.branch.phone',
      '*.passwordHash',
      '*.mfaSecret',
      '*.abhaNumber',
    ],
    censor: '[redacted]',
  },
  ...(config.isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }
    : {}),
});
