import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import Layout from '../components/Layout';
import { useAuthStore } from '../stores/authStore';
import { billingApi } from '../api/billing.api';
import type { UserRole } from '../api/auth.api';

const ALL_ROLES: UserRole[] = ['ADMIN', 'PROJECT_MANAGER', 'LINGUIST'];

export default function BillingSettingsPage() {
  const user = useAuthStore((s) => s.user);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [dailyCapUsd, setDailyCapUsd] = useState(1.5);
  const [proMinRemainingUsd, setProMinRemainingUsd] = useState(0.5);
  const [warnInputTokens, setWarnInputTokens] = useState(50_000);
  const [maxPromptChars, setMaxPromptChars] = useState(2_000_000);
  const [powerRoles, setPowerRoles] = useState<UserRole[]>(['ADMIN']);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await billingApi.getSettings();
        if (cancelled) return;
        setEnabled(s.enabled);
        setDailyCapUsd(s.dailyCapUsd);
        setProMinRemainingUsd(s.proMinRemainingUsd);
        setWarnInputTokens(s.warnInputTokens);
        setMaxPromptChars(s.maxPromptChars);
        setPowerRoles(s.powerRoles.length ? s.powerRoles : ['ADMIN']);
        setUpdatedAt(s.updatedAt);
      } catch (e: unknown) {
        if (!cancelled) {
          const msg =
            (e as { response?: { data?: { error?: string; message?: string } } })?.response?.data?.message ||
            (e as { response?: { data?: { error?: string; message?: string } } })?.response?.data?.error ||
            'Failed to load billing settings';
          toast.error(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!user) {
    return (
      <Layout>
        <p className="text-gray-600">Log in to continue.</p>
      </Layout>
    );
  }

  if (user.role !== 'ADMIN') {
    return <Navigate to="/" replace />;
  }

  const toggleRole = (role: UserRole) => {
    setPowerRoles((prev) => {
      if (prev.includes(role)) {
        const next = prev.filter((r) => r !== role);
        return next.length ? next : prev;
      }
      return [...prev, role];
    });
  };

  const save = async () => {
    if (powerRoles.length === 0) {
      toast.error('Select at least one power role');
      return;
    }
    setSaving(true);
    try {
      const s = await billingApi.updateSettings({
        enabled,
        dailyCapUsd,
        proMinRemainingUsd,
        warnInputTokens,
        maxPromptChars,
        powerRoles,
      });
      setUpdatedAt(s.updatedAt);
      toast.success('Billing settings saved');
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { error?: string; message?: string } } })?.response?.data?.message ||
        (e as { response?: { data?: { error?: string; message?: string } } })?.response?.data?.error ||
        'Save failed';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Layout>
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">Billing & usage caps</h1>
        <p className="text-sm text-gray-600 mb-6">
          Controls daily AI spend limits, prompt guards, and which roles may still use expensive models when the
          remaining budget is low. Per-model prices stay in{' '}
          <code className="text-xs bg-gray-100 px-1 rounded">backend/config/billing-pricing.v1.json</code> on the
          server.
        </p>

        {loading ? (
          <p className="text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-6 bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="rounded border-gray-300" />
              <span className="text-sm font-medium text-gray-900">Enable billing / daily cap enforcement</span>
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Daily cap (USD)</label>
                <input
                  type="number"
                  step="0.01"
                  min={0.01}
                  value={dailyCapUsd}
                  onChange={(e) => setDailyCapUsd(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Min. remaining for expensive models (USD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={proMinRemainingUsd}
                  onChange={(e) => setProMinRemainingUsd(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Below this remaining balance, expensive models are blocked for users who are not in the power
                  roles below.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Log warning from est. input tokens</label>
                <input
                  type="number"
                  min={100}
                  value={warnInputTokens}
                  onChange={(e) => setWarnInputTokens(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Max prompt size (characters)</label>
                <input
                  type="number"
                  min={10000}
                  value={maxPromptChars}
                  onChange={(e) => setMaxPromptChars(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div>
              <span className="block text-xs font-medium text-gray-700 mb-2">
                Power roles (may use expensive models when remaining &lt; min. above)
              </span>
              <div className="flex flex-wrap gap-4">
                {ALL_ROLES.map((role) => (
                  <label key={role} className="inline-flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={powerRoles.includes(role)}
                      onChange={() => toggleRole(role)}
                      className="rounded border-gray-300"
                    />
                    {role.replace(/_/g, ' ')}
                  </label>
                ))}
              </div>
            </div>

            {updatedAt && (
              <p className="text-xs text-gray-400">Last updated: {new Date(updatedAt).toLocaleString()}</p>
            )}

            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center px-4 py-2 rounded-md bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        )}
      </div>
    </Layout>
  );
}
