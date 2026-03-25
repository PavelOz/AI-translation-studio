import type { AIProvider, ProviderPromptRequest, ProviderPromptResponse } from './types';
import * as billing from '../../services/billing-manager.service';
import { isBillingActive } from '../../services/billing-config.service';

/**
 * Wraps callModel only. callModelWithRetry must stay unwrapped so BaseProvider retries call this.callModel,
 * which resolves to the proxy's wrapped callModel (single preflight + record per successful attempt).
 * Billing on/off is evaluated per request so admins can toggle without restarting.
 */
export function wrapProviderInstanceWithBilling<T extends AIProvider>(inner: T): T {
  const wrappedCallModel = async (request: ProviderPromptRequest): Promise<ProviderPromptResponse> => {
    if (!isBillingActive()) {
      return inner.callModel(request);
    }
    const model = request.model ?? inner.defaultModel;
    billing.assertPreFlight(inner.name, model, request);
    const res = await inner.callModel(request);
    billing.recordUsageAfterCall(inner.name, model, res.usage);
    return res;
  };

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'callModel') {
        return wrappedCallModel;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}
