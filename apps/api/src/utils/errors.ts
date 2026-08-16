/**
 * Base application error class
 * All custom errors should extend this
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code: string;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    isOperational: boolean = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;

    // Maintains proper stack trace
    Error.captureStackTrace(this, this.constructor);

    // Set prototype explicitly for instanceof to work
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * 400 - Validation Error
 */
export class ValidationError extends AppError {
  public readonly errors: Record<string, string[]>;

  constructor(message: string = 'Validation failed', errors: Record<string, string[]> = {}) {
    super(message, 400, 'VALIDATION_ERROR');
    this.errors = errors;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * 401 - Authentication Error
 */
export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 401, 'AUTHENTICATION_ERROR');
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * 403 - Authorization Error
 */
export class AuthorizationError extends AppError {
  constructor(message: string = 'Access denied') {
    super(message, 403, 'AUTHORIZATION_ERROR');
    Object.setPrototypeOf(this, AuthorizationError.prototype);
  }
}

/**
 * 404 - Not Found Error
 */
export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * 409 - Conflict Error
 */
export class ConflictError extends AppError {
  constructor(message: string = 'Resource already exists') {
    super(message, 409, 'CONFLICT');
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

/**
 * 429 - Rate Limit Error
 */
export class RateLimitError extends AppError {
  constructor(message: string = 'Too many requests') {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/**
 * 422 — the rules of this place do not permit what was asked (PI-7).
 *
 * ⚠️ NOT A `403`, AND THE DISTINCTION IS THE WHOLE REASON THIS CLASS EXISTS. A
 *   403 says "you are not allowed to do this" — a statement about the caller's
 *   permissions, which they can do nothing about at the counter. A regulatory
 *   refusal says "this supply is not lawful here, today, for this product", which
 *   is a statement about the transaction: the same pharmacist with the same
 *   permissions may lawfully dispense the next prescription in the queue.
 *   Rendering one as the other sends a pharmacist to an administrator to have a
 *   permission fixed that was never wrong.
 *
 * ⚠️ THE MESSAGE IS THE RULE'S OWN SENTENCE, VERBATIM. `regulatory_rules
 *   .statement` is written to be read by the person who is refused and says what
 *   to DO about it; a message composed here would lose that and would drift from
 *   what the regulatory console shows for the same rule.
 *
 * ⚠️ AND `UNDETERMINED` COMES THROUGH THIS CLASS TOO. "No rule covers this" is
 *   not "carry on" — see `@rcln/regulatory`'s header. It only reaches here at
 *   all when the pack is `PRODUCTION_ENABLED`; below that the decision is
 *   recorded and reported and stops nothing (`regulatory/enforcement.ts`).
 */
export class RegulatoryRefusalError extends AppError {
  /**
   * Rule CODES and the sentences they carry — never rule ids and never pack
   * versions. API_ARCHITECTURE.md's sketch of this payload names both; the
   * counter must not be shown engine internals (FRONTEND_ARCHITECTURE.md), and
   * the full decision is snapshotted in `regulatory_decisions` regardless of
   * what any screen renders.
   */
  public readonly details: Record<string, string[]>;

  constructor(
    message: string,
    details: { outcome: string; ruleCodes: readonly string[]; messages: readonly string[] }
  ) {
    super(message, 422, 'REGULATORY_REFUSED');
    /*
     * Shaped as the error envelope's `Record<string, string[]>` rather than as a
     * nested object, because that is what `sendError` puts on the wire and a
     * second shape would only be flattened somewhere less obvious.
     */
    this.details = {
      outcome: [details.outcome],
      ruleCodes: [...details.ruleCodes],
      messages: [...details.messages],
    };
    Object.setPrototypeOf(this, RegulatoryRefusalError.prototype);
  }
}
