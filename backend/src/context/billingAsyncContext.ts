import { AsyncLocalStorage } from 'async_hooks';

export type BillingRuntimeContext = {
  userId: string;
  role: string;
};

const storage = new AsyncLocalStorage<BillingRuntimeContext | undefined>();

export const billingAsyncContext = {
  run<T>(ctx: BillingRuntimeContext | undefined, fn: () => T): T {
    return storage.run(ctx, fn);
  },

  get(): BillingRuntimeContext | undefined {
    return storage.getStore();
  },
};
