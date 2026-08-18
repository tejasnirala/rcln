import { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { type ZodSchema, ZodError, type ZodIssue } from 'zod';
import { sendError } from '../utils/response.js';

/**
 * Location of data to validate
 */
export type ValidationSource = 'body' | 'query' | 'params';

/**
 * What a `validate(...)` handler was built with, legible from outside the
 * closure.
 *
 * ⚠️ THE SAME TRICK `authorize()` USES, FOR THE SAME REASON AND WITH ONE MORE.
 *   An Express router stack is a list of anonymous functions, so "what shape does
 *   this endpoint accept" is a question nothing could ask — and the OpenAPI
 *   document has to answer it for 289 endpoints without anybody maintaining a
 *   second copy of every contract by hand. A second copy is not merely tedious;
 *   it is wrong the first time a contract changes and nothing fails.
 *
 *   Non-enumerable so it stays out of logs and out of anything that serialises a
 *   middleware stack, exactly as `requiredPermissions` is.
 */
export interface ValidatedShape {
  readonly schema: ZodSchema;
  readonly source: ValidationSource;
}

/** Stamp the schemas a handler validates onto the handler itself. */
function describeValidator<T extends object>(handler: T, shapes: ValidatedShape[]): T {
  Object.defineProperty(handler, 'validatedShapes', {
    value: Object.freeze(shapes),
    enumerable: false,
  });
  return handler;
}

/** The shapes a `validate(...)` / `validateMultiple(...)` handler enforces, if it is one. */
export function validatedShapesOf(handler: unknown): readonly ValidatedShape[] | null {
  if (typeof handler !== 'function') return null;
  const shapes = (handler as { validatedShapes?: unknown }).validatedShapes;
  return Array.isArray(shapes) ? (shapes as ValidatedShape[]) : null;
}

/**
 * Write the parsed value back onto the request.
 *
 * `req.body` is a plain property and assigns normally. `req.query` in Express 5
 * is a GETTER WITH NO SETTER, and because this file is not in strict mode the
 * assignment fails *silently* — no throw, no warning, and `req.query` keeps the
 * raw string values.
 *
 * That is invisible until a schema does real work: `paginationQuery` uses
 * `z.coerce.number()` and `.default()`, so a handler would read the string "2"
 * where it expects the number 2, and read `undefined` where it expects a
 * default. It typechecks perfectly, because the cast below erases the evidence.
 *
 * defineProperty replaces the accessor outright, which is the only assignment
 * Express 5 respects.
 */
function assignParsed(req: Request, source: ValidationSource, value: unknown): void {
  if (source === 'query') {
    Object.defineProperty(req, 'query', {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any)[source] = value;
}

/**
 * Validation middleware factory
 *
 * @example
 * router.post('/users', validate(createUserSchema, 'body'), createUser);
 * router.get('/users/:id', validate(userIdSchema, 'params'), getUser);
 */
export const validate = (schema: ZodSchema, source: ValidationSource = 'body'): RequestHandler => {
  const handler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data: unknown = req[source];
      const validated: unknown = await schema.parseAsync(data);

      // Replace with validated/transformed data
      assignParsed(req, source, validated);

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors: Record<string, string[]> = {};
        const issues = error.issues as ZodIssue[];
        issues.forEach((err: ZodIssue) => {
          const path = err.path.join('.') || source;
          if (!errors[path]) {
            errors[path] = [];
          }
          errors[path].push(err.message);
        });

        sendError(res, 'Validation failed', 400, errors);
        return;
      }
      next(error);
    }
  };

  return describeValidator(handler, [{ schema, source }]);
};

/**
 * Validate multiple sources at once
 *
 * @example
 * router.patch('/users/:id',
 *   validateMultiple({ params: userIdSchema, body: updateUserSchema }),
 *   updateUser
 * );
 */
export const validateMultiple = (
  schemas: Partial<Record<ValidationSource, ZodSchema>>
): RequestHandler => {
  const handler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      for (const [source, schema] of Object.entries(schemas)) {
        if (schema) {
          const data: unknown = req[source as ValidationSource];
          const validated: unknown = await schema.parseAsync(data);
          assignParsed(req, source as ValidationSource, validated);
        }
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors: Record<string, string[]> = {};
        const issues = error.issues as ZodIssue[];
        issues.forEach((err: ZodIssue) => {
          const path = err.path.join('.') || 'unknown';
          if (!errors[path]) {
            errors[path] = [];
          }
          errors[path].push(err.message);
        });

        sendError(res, 'Validation failed', 400, errors);
        return;
      }
      next(error);
    }
  };

  return describeValidator(
    handler,
    Object.entries(schemas)
      .filter((entry): entry is [ValidationSource, ZodSchema] => entry[1] !== undefined)
      .map(([source, schema]) => ({ schema, source }))
  );
};
