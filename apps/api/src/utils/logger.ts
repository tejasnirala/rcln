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
