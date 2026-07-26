import { type Request, type Response, type NextFunction } from 'express';
import { type ZodSchema, ZodError, type ZodIssue } from 'zod';
import { sendError } from '../utils/response.js';

/**
 * Location of data to validate
 */
type ValidationSource = 'body' | 'query' | 'params';

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
export const validate = (schema: ZodSchema, source: ValidationSource = 'body') => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
export const validateMultiple = (schemas: Partial<Record<ValidationSource, ZodSchema>>) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
};
