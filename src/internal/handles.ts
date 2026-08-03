import { ValidationError } from '../errors.js';
import type { PooledResource, ResourceHolder, TakeOptions, UnitaryResource } from '../types.js';

/**
 * How a handle takes: the amount is settled by whoever built the handle, not by the
 * caller of `take`.
 */
export type TakeFn = (
  key: string,
  amount: number,
  options: TakeOptions,
) => Promise<ResourceHolder>;

/**
 * The handles both implementations hand out.
 *
 * Built here rather than twice, so the real client and the in-memory one cannot end up
 * with handles that behave differently — which is the whole reason the mock is worth
 * having.
 */
export function unitaryHandle(key: string, take: TakeFn): UnitaryResource {
  requireKey(key);

  return {
    key,
    take: (options: TakeOptions = {}) => take(key, 1, options),
  };
}

export function pooledHandle(key: string, take: TakeFn): PooledResource {
  requireKey(key);

  return {
    key,
    take: (options: TakeOptions = {}) => take(key, 1, options),
    takeMany: (amount: number, options: TakeOptions = {}) => {
      if (!Number.isFinite(amount) || amount <= 0) {
        return Promise.reject(new ValidationError('amount must be greater than zero'));
      }
      return take(key, amount, options);
    },
  };
}

/** Caught when the handle is built, so the error points at the line that made it. */
function requireKey(key: string): void {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ValidationError('a resource key is required');
  }
}
