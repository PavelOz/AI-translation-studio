import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import Layout from '../components/Layout';
import { useAuthStore } from '../stores/authStore';
import { billingApi, type BillingPricingFile } from '../api/billing.api';
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
  /** 'file' = store null in DB, use bundled JSON; 'database' = save textarea JSON */
  const [pricingMode, setPricingMode] = useState<'file' | 'database'>('file');
  const [pricingText, setPricingText] = useState('');
  const [loadingTemplate, setLoadingTemplate] = useState(false);

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
        if (s.pricingSource === 'database' && s.pricingJson != null) {
          setPricingMode('database');
          setPricingText(JSON.stringify(s.pricingJson, null, 2));
        } else {
          setPricingMode('file');
          setPricingText('');
        }
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

  const loadTemplateFromServerFile = async () => {
    setLoadingTemplate(true);
    try {
      const tpl = await billingApi.getPricingTemplate();
      setPricingText(JSON.stringify(tpl, null, 2));
      setPricingMode('database');
      toast.success('Loaded pricing from bundled server file into the editor');
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { error?: string; message?: string } } })?.response?.data?.message ||
        'Failed to load pricing template';
      toast.error(msg);
    } finally {
      setLoadingTemplate(false);
    }
  };

  const save = async () => {
    if (powerRoles.length === 0) {
      toast.error('Select at least one power role');
      return;
    }
    let pricingJson: BillingPricingFile | null;
    if (pricingMode === 'file') {
      pricingJson = null;
    } else {
      try {
        pricingJson = JSON.parse(pricingText) as BillingPricingFile;
      } catch {
        toast.error('Pricing JSON is invalid (check syntax)');
        return;
      }
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
        pricingJson,
      });
      setUpdatedAt(s.updatedAt);
      if (s.pricingSource === 'database' && s.pricingJson != null) {
        setPricingMode('database');
        setPricingText(JSON.stringify(s.pricingJson, null, 2));
      } else {
        setPricingMode('file');
        setPricingText('');
      }
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
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">Billing & usage caps</h1>
        <p className="text-sm text-gray-600 mb-6">
          Daily caps, prompt guards, power roles, and optionally a custom pricing table. When pricing is stored here, it
          overrides the bundled <code className="text-xs bg-gray-100 px-1 rounded">backend/config/billing-pricing.v1.json</code>{' '}
          file until you switch back to the server file.
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

            <div className="border-t border-gray-200 pt-6 space-y-3">
              <h2 className="text-sm font-semibold text-gray-900">Model pricing (JSON)</h2>
              <div className="flex flex-wrap gap-3 items-center">
                <label className="inline-flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                  <input
                    type="radio"
                    name="pricingMode"
                    checked={pricingMode === 'file'}
                    onChange={() => setPricingMode('file')}
                    className="border-gray-300"
                  />
                  Use bundled server file
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                  <input
                    type="radio"
                    name="pricingMode"
                    checked={pricingMode === 'database'}
                    onChange={() => setPricingMode('database')}
                    className="border-gray-300"
                  />
                  Store custom pricing in database
                </label>
                <button
                  type="button"
                  onClick={loadTemplateFromServerFile}
                  disabled={loadingTemplate}
                  className="text-sm text-primary-600 hover:text-primary-800 disabled:opacity-50"
                >
                  {loadingTemplate ? 'Loading…' : 'Load bundled file into editor'}
                </button>
              </div>
              {pricingMode === 'database' ? (
                <textarea
                  value={pricingText}
                  onChange={(e) => setPricingText(e.target.value)}
                  spellCheck={false}
                  className="w-full min-h-[280px] font-mono text-xs border border-gray-300 rounded-md p-3"
                  placeholder='{ "version": 1, "currency": "USD", "defaultPer1M": { ... }, "models": { ... } }'
                />
              ) : (
                <p className="text-xs text-gray-500">
                  Active pricing is read from the server JSON file. Choose &quot;Store custom pricing&quot; and optionally
                  &quot;Load bundled file&quot; to edit and save a copy in the database.
                </p>
              )}
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
