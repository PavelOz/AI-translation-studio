import type { Request, Response, NextFunction } from 'express';
import { tryVerifyToken } from '../utils/auth';
import { billingAsyncContext } from '../context/billingAsyncContext';

/**
 * Attaches billing identity from JWT when present, without requiring auth.
 * Actual enforcement only runs when BILLING_ENABLED and LLM calls occur.
 */
export const billingContextMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  let ctx: { userId: string; role: string } | undefined;
  if (header) {
    const [, token] = header.split(' ');
    if (token) {
      const payload = tryVerifyToken(token);
      if (payload) {
        ctx = { userId: payload.userId, role: payload.role };
      }
    }
  }

  billingAsyncContext.run(ctx, () => next());
};
