import { type Request, type Response, type NextFunction } from 'express';
import { ZodError, type ZodIssue } from 'zod';

/** Structural check for a Prisma known-request error. */
const isPrismaKnownError = (e: Error): e is Error & { code: string } =>
  e.name === 'PrismaClientKnownRequestError' && typeof (e as { code?: unknown }).code === 'string';

import { AppError, ValidationError } from '../utils/errors.js';
import { sendError } from '../utils/response.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

/**
 * Format Zod validation errors
 */
const formatZodErrors = (error: ZodError): Record<string, string[]> => {
  const errors: Record<string, string[]> = {};
  const issues = error.issues;
  issues.forEach((err: ZodIssue) => {
    const path = err.path.join('.');
    if (!errors[path]) {
      errors[path] = [];
    }
    errors[path].push(err.message);
  });
  return errors;
};

/**
 * Global error handler middleware
 * Must be registered LAST in middleware chain
 */
export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): Response => {
  // Log error
  logger.error(
    {
      name: err.name,
      message: err.message,
      stack: config.isDevelopment ? err.stack : undefined,
      path: req.path,
      method: req.method,
    },
    'error caught by handler'
  );

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    return sendError(res, 'Validation failed', 400, formatZodErrors(err));
  }

  // Handle custom validation errors
  if (err instanceof ValidationError) {
    return sendError(res, err.message, err.statusCode, err.errors);
  }

  // Handle custom application errors
  if (err instanceof AppError) {
    return sendError(res, err.message, err.statusCode);
  }

  // Handle Prisma errors.
  // Narrowed via a code check rather than instanceof: the generated client and
  // the app can end up with separate class identities under pnpm's symlinked
  // node_modules, which silently breaks instanceof.
  if (isPrismaKnownError(err)) {
    switch (err.code) {
      case 'P2002': // Unique constraint violation
        return sendError(res, 'A record with this value already exists', 409);
      case 'P2025': // Record not found
        return sendError(res, 'Record not found', 404);
      case 'P2003': // Foreign key constraint violation
        return sendError(res, 'Related record not found', 400);
      default:
        return sendError(res, 'Database error', 500);
    }
  }

  if (err.name === 'PrismaClientValidationError') {
    return sendError(res, 'Invalid data provided', 400);
  }

  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    return sendError(res, 'Invalid token', 401);
  }

  if (err.name === 'TokenExpiredError') {
    return sendError(res, 'Token expired', 401);
  }

  // Default to 500 internal server error
  const message = config.isProduction ? 'Internal server error' : err.message;
  return sendError(res, message, 500);
};

/**
 * 404 Not Found handler
 * Register AFTER all routes
 */
export const notFoundHandler = (req: Request, res: Response): Response => {
  return sendError(res, `Route ${req.method} ${req.path} not found`, 404);
};
