import { useCallback, useEffect, useState } from 'react';
import { billingApi } from '../api/billing.api';
import { useAuthStore } from '../stores/authStore';

export default function BillingStatusBar() {
  const token = useAuthStore((s) => s.token);
  const [data, setData] = useState<Awaited<ReturnType<typeof billingApi.getToday>> | null>(null);

  const refresh = useCallback(async () => {
    if (!token) {
      setData(null);
      return;
    }
    try {
      const r = await billingApi.getToday();
      setData(r);
    } catch {
      setData(null);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!token || !data?.enabled) return;
    const id = window.setInterval(refresh, 45_000);
    return () => window.clearInterval(id);
  }, [token, data?.enabled, refresh]);

  if (!token || !data?.enabled) return null;

  const pct = data.capUsd > 0 ? Math.min(100, (data.spentUsd / data.capUsd) * 100) : 0;
  const warn = pct >= 80;
  const danger = pct >= 95 || data.remainingUsd <= data.minRemainingForExpensiveUsd;

  return (
    <div
      className={`text-xs px-2 py-1 rounded border ${
        danger
          ? 'bg-red-50 text-red-800 border-red-200'
          : warn
            ? 'bg-amber-50 text-amber-900 border-amber-200'
            : 'bg-slate-50 text-slate-700 border-slate-200'
      }`}
      title={`Resets on UTC date ${data.dateKey}. Expensive models may be blocked when remaining is below $${data.minRemainingForExpensiveUsd}.`}
    >
      Spent today:{' '}
      <span className="font-semibold tabular-nums">${data.spentUsd.toFixed(2)}</span>
      {' / '}
      <span className="tabular-nums">${data.capUsd.toFixed(2)}</span>
    </div>
  );
}
