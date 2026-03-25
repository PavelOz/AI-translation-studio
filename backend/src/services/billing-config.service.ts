import type { BillingSettings } from '@prisma/client';
import { prisma } from '../db/prisma';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

export type BillingRuntimeConfig = {
  enabled: boolean;
  dailyCapUsd: number;
  proMinRemainingUsd: number;
  warnInputTokens: number;
  maxPromptChars: number;
  powerRoles: string[];
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
    memory = rowToMemory(row);
    logger.info({ enabled: memory.enabled }, 'Billing settings loaded from database');
  } catch (error) {
    logger.warn({ error }, 'Billing DB init failed; using environment defaults (run prisma migrate if needed)');
    memory = snapshotFromEnv();
  }
}

export async function getBillingSettingsForAdmin(): Promise<BillingRuntimeConfig & { updatedAt: string }> {
  const row = await prisma.billingSettings.findUnique({ where: { id: 'default' } });
  if (!row) {
    return {
      ...getBillingConfig(),
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    ...rowToMemory(row),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function updateBillingSettings(
  next: BillingRuntimeConfig,
): Promise<BillingRuntimeConfig & { updatedAt: string }> {
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
    },
    update: {
      enabled: next.enabled,
      dailyCapUsd: next.dailyCapUsd,
      proMinRemainingUsd: next.proMinRemainingUsd,
      warnInputTokens: next.warnInputTokens,
      maxPromptChars: next.maxPromptChars,
      powerRoles: next.powerRoles.join(','),
    },
  });
  memory = rowToMemory(row);
  return {
    ...memory,
    updatedAt: row.updatedAt.toISOString(),
  };
}
