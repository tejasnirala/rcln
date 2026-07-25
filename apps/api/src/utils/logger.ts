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
