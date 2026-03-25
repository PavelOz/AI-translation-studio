import fs from 'fs';
import path from 'path';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import { billingAsyncContext } from '../context/billingAsyncContext';
import type { ProviderUsage } from '../ai/providers/types';
import { getBillingConfig } from './billing-config.service';

type PricingTier = 'standard' | 'expensive';

type PricingLine = {
  inputPer1M: number;
  outputPer1M: number;
  tier: PricingTier;
};

type PricingFile = {
  version: number;
  currency: string;
  defaultPer1M: PricingLine;
  models: Record<string, PricingLine>;
};

function utcDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function loadPricing(): PricingFile {
  const file = path.join(__dirname, '../../config/billing-pricing.v1.json');
  const raw = fs.readFileSync(file, 'utf-8');
  return JSON.parse(raw) as PricingFile;
}

let cachedPricing: PricingFile | null = null;
function pricing(): PricingFile {
  if (!cachedPricing) cachedPricing = loadPricing();
  return cachedPricing;
}

/** Rough token estimate (~4 chars/token); replace with tiktoken/Gemini count where needed. */
export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

function modelKey(provider: string, model: string): string {
  return `${provider.toLowerCase()}:${model.replace(/^models\//i, '').toLowerCase()}`;
}

export function getPricingLine(provider: string, model: string): PricingLine {
  const p = pricing();
  const key = modelKey(provider, model);
  return p.models[key] ?? p.defaultPer1M;
}

export function isExpensiveModel(provider: string, model: string): boolean {
  return getPricingLine(provider, model).tier === 'expensive';
}

export function computeCostUsd(provider: string, model: string, usage: ProviderUsage | undefined): number {
  if (!usage) return 0;
  const line = getPricingLine(provider, model);
  const inTok = usage.inputTokens ?? 0;
  const outTok = usage.outputTokens ?? 0;
  return (inTok / 1_000_000) * line.inputPer1M + (outTok / 1_000_000) * line.outputPer1M;
}

const spendByKey = new Map<string, number>();

function spendKey(userId: string, dateKey: string): string {
  return `${userId}:${dateKey}`;
}

function effectiveUserId(): string {
  return billingAsyncContext.get()?.userId ?? '_anonymous';
}

function powerRolesList(): string[] {
  return getBillingConfig().powerRoles;
}

function isPowerRole(role: string | undefined): boolean {
  if (!role) return false;
  return powerRolesList().includes(role.toUpperCase());
}

export function getBillingTodayForUser(userId: string, dateKey = utcDateKey()): {
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
  dateKey: string;
  enabled: boolean;
} {
  const cfg = getBillingConfig();
  const enabled = cfg.enabled;
  const capUsd = cfg.dailyCapUsd;
  const spentUsd = enabled ? spendByKey.get(spendKey(userId, dateKey)) ?? 0 : 0;
  return {
    spentUsd,
    capUsd,
    remainingUsd: Math.max(0, capUsd - spentUsd),
    dateKey,
    enabled,
  };
}

export function assertPreFlight(provider: string, model: string, request: { prompt: string; systemPrompt?: string }) {
  const cfg = getBillingConfig();
  if (!cfg.enabled) return;

  const userId = effectiveUserId();
  const role = billingAsyncContext.get()?.role;
  const today = getBillingTodayForUser(userId);

  const combined = `${request.systemPrompt ?? ''}\n${request.prompt ?? ''}`;
  if (combined.length > cfg.maxPromptChars) {
    throw ApiError.badRequest(
      `Prompt too large for billing policy (${combined.length} chars, max ${cfg.maxPromptChars}).`,
    );
  }

  const estIn = estimateTokensFromText(combined);
  if (estIn >= cfg.warnInputTokens) {
    logger.warn(
      { userId, provider, model, estInputTokens: estIn, chars: combined.length },
      'Large LLM request (estimated input tokens)',
    );
  }

  if (today.spentUsd >= today.capUsd) {
    throw ApiError.paymentRequired(
      `Daily AI usage cap reached ($${today.spentUsd.toFixed(4)} / $${today.capUsd.toFixed(2)}). Raise the cap in Admin → Billing or wait until UTC tomorrow.`,
    );
  }

  const expensive = isExpensiveModel(provider, model);
  const lowBalance = today.remainingUsd < cfg.proMinRemainingUsd;
  if (expensive && lowBalance && !isPowerRole(role)) {
    throw ApiError.forbidden(
      `Expensive model blocked: remaining daily budget $${today.remainingUsd.toFixed(4)} is below $${cfg.proMinRemainingUsd} (use a cheaper model, increase the cap, or wait until tomorrow).`,
    );
  }
}

export function recordUsageAfterCall(
  provider: string,
  model: string,
  usage: ProviderUsage | undefined,
): { costUsd: number; dateKey: string } {
  if (!getBillingConfig().enabled) return { costUsd: 0, dateKey: utcDateKey() };

  const cost = computeCostUsd(provider, model, usage);
  if (cost <= 0) return { costUsd: 0, dateKey: utcDateKey() };

  const userId = effectiveUserId();
  const dk = utcDateKey();
  const key = spendKey(userId, dk);
  const prev = spendByKey.get(key) ?? 0;
  spendByKey.set(key, prev + cost);

  logger.debug({ userId, provider, model, costUsd: cost, spentDay: prev + cost }, 'Billing usage recorded');

  return { costUsd: cost, dateKey: dk };
}
