import type { BillingSettings, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { env } from '../utils/env';
import { logger } from '../utils/logger';
import { parsePricingFile, safeParsePricingFile } from './billing-pricing.schema';
import { setPricingDbOverride } from './billing-pricing.runtime';

export type BillingRuntimeConfig = {
  enabled: boolean;
  dailyCapUsd: number;
  proMinRemainingUsd: number;
  warnInputTokens: number;
  maxPromptChars: number;
  powerRoles: string[];
};

export type BillingAdminSettingsDTO = BillingRuntimeConfig & {
  updatedAt: string;
  pricingJson: Prisma.JsonValue | null;
  pricingSource: 'database' | 'file';
};

let memory: BillingRuntimeConfig = snapshotFromEnv();

export function snapshotFromEnv(): BillingRuntimeConfig {
  return {
    enabled: env.billingEnabled,
    dailyCapUsd: env.billingDailyCapUsd,
    proMinRemainingUsd: env.billingProMinRemainingUsd,
    warnInputTokens: env.billingWarnInputTokens,
    maxPromptChars: env.billingMaxPromptChars,
    powerRoles: [...env.billingPowerRoles],
  };
}

function parsePowerRolesCsv(csv: string): string[] {
  return csv
    .split(',')
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);
}

function applyPricingFromRow(pricingJson: Prisma.JsonValue | null | undefined) {
  if (pricingJson == null || pricingJson === undefined) {
    setPricingDbOverride(null);
    return;
  }
  const parsed = safeParsePricingFile(pricingJson);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'Invalid pricingJson in database; falling back to bundled file');
    setPricingDbOverride(null);
    return;
  }
  setPricingDbOverride(parsed.data);
}

export function rowToMemory(row: BillingSettings): BillingRuntimeConfig {
  return {
    enabled: row.enabled,
    dailyCapUsd: row.dailyCapUsd,
    proMinRemainingUsd: row.proMinRemainingUsd,
    warnInputTokens: row.warnInputTokens,
    maxPromptChars: row.maxPromptChars,
    powerRoles: parsePowerRolesCsv(row.powerRoles),
  };
}

export function getBillingConfig(): BillingRuntimeConfig {
  return memory;
}

export function isBillingActive(): boolean {
  return memory.enabled;
}

function hydrateFromRow(row: BillingSettings) {
  memory = rowToMemory(row);
  applyPricingFromRow(row.pricingJson);
}

/** Call once after DB is ready. Creates the singleton row from env if missing. */
export async function initBillingConfigFromDb(): Promise<void> {
  try {
    let row = await prisma.billingSettings.findUnique({ where: { id: 'default' } });
    if (!row) {
      const snap = snapshotFromEnv();
      await prisma.billingSettings.create({
        data: {
          id: 'default',
          enabled: snap.enabled,
          dailyCapUsd: snap.dailyCapUsd,
          proMinRemainingUsd: snap.proMinRemainingUsd,
          warnInputTokens: snap.warnInputTokens,
          maxPromptChars: snap.maxPromptChars,
          powerRoles: snap.powerRoles.join(','),
        },
      });
      row = await prisma.billingSettings.findUniqueOrThrow({ where: { id: 'default' } });
    }
    hydrateFromRow(row);
    logger.info(
      { enabled: memory.enabled, pricingSource: row.pricingJson ? 'database' : 'file' },
      'Billing settings loaded from database',
    );
  } catch (error) {
    logger.warn({ error }, 'Billing DB init failed; using environment defaults (run prisma migrate if needed)');
    memory = snapshotFromEnv();
    setPricingDbOverride(null);
  }
}

export async function getBillingSettingsForAdmin(): Promise<BillingAdminSettingsDTO> {
  const row = await prisma.billingSettings.findUnique({ where: { id: 'default' } });
  if (!row) {
    return {
      ...getBillingConfig(),
      updatedAt: new Date(0).toISOString(),
      pricingJson: null,
      pricingSource: 'file',
    };
  }
  return {
    ...rowToMemory(row),
    updatedAt: row.updatedAt.toISOString(),
    pricingJson: row.pricingJson,
    pricingSource: row.pricingJson == null ? 'file' : 'database',
  };
}

export async function updateBillingSettings(
  next: BillingRuntimeConfig & { pricingJson?: unknown | null },
): Promise<BillingAdminSettingsDTO> {
  const pricingPart: { pricingJson?: Prisma.InputJsonValue | null } =
    Object.prototype.hasOwnProperty.call(next, 'pricingJson')
      ? {
          pricingJson:
            next.pricingJson === null
              ? null
              : (parsePricingFile(next.pricingJson) as unknown as Prisma.InputJsonValue),
        }
      : {};

  const row = await prisma.billingSettings.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      enabled: next.enabled,
      dailyCapUsd: next.dailyCapUsd,
      proMinRemainingUsd: next.proMinRemainingUsd,
      warnInputTokens: next.warnInputTokens,
      maxPromptChars: next.maxPromptChars,
      powerRoles: next.powerRoles.join(','),
      ...pricingPart,
    },
    update: {
      enabled: next.enabled,
      dailyCapUsd: next.dailyCapUsd,
      proMinRemainingUsd: next.proMinRemainingUsd,
      warnInputTokens: next.warnInputTokens,
      maxPromptChars: next.maxPromptChars,
      powerRoles: next.powerRoles.join(','),
      ...pricingPart,
    },
  });
  hydrateFromRow(row);
  return {
    ...memory,
    updatedAt: row.updatedAt.toISOString(),
    pricingJson: row.pricingJson,
    pricingSource: row.pricingJson == null ? 'file' : 'database',
  };
}
