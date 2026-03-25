import dotenv from 'dotenv';

dotenv.config();

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const boolFromEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1' || value.toLowerCase() === 'yes';
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: numberFromEnv(process.env.PORT, 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret',
  databaseUrl: process.env.DATABASE_URL ?? '',
  fileStorageDir: process.env.FILE_STORAGE_DIR ?? '../storage',
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  openAiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-pro',
  yandexApiKey: process.env.YANDEX_API_KEY ?? '',
  yandexModel: process.env.YANDEX_MODEL ?? 'yandexgpt-lite',
  yandexFolderId: process.env.YANDEX_FOLDER_ID ?? '',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
  deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  claudeApiKey: process.env.CLAUDE_API_KEY ?? '',
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-20250514',
  defaultAIProvider: (process.env.DEFAULT_AI_PROVIDER ?? 'gemini').toLowerCase(),
  aiBatchSize: numberFromEnv(process.env.AI_BATCH_SIZE, 20),
  aiMaxRetries: numberFromEnv(process.env.AI_MAX_RETRIES, 3),
  azureTranslationEndpoint: process.env.AZURE_TRANSLATION_ENDPOINT ?? '',
  azureTranslationKey: process.env.AZURE_TRANSLATION_KEY ?? '',
  useLibreOffice: process.env.USE_LIBRE_OFFICE === 'true',
  libreOfficePath: process.env.LIBRE_OFFICE_PATH ?? 'libreoffice',

  /** Billing / usage caps (optional; off by default). */
  billingEnabled: boolFromEnv(process.env.BILLING_ENABLED, false),
  billingDailyCapUsd: numberFromEnv(process.env.BILLING_DAILY_CAP_USD, 1.5),
  /** Below this remaining balance (USD), expensive models are blocked for non–power users. */
  billingProMinRemainingUsd: numberFromEnv(process.env.BILLING_PRO_MIN_REMAINING_USD, 0.5),
  /** Warn in logs when estimated input tokens exceed this (soft guard). */
  billingWarnInputTokens: numberFromEnv(process.env.BILLING_WARN_INPUT_TOKENS, 50_000),
  /** Reject requests when combined prompt length exceeds this (chars). */
  billingMaxPromptChars: numberFromEnv(process.env.BILLING_MAX_PROMPT_CHARS, 2_000_000),
  /**
   * Roles that may use expensive models when remaining balance is below billingProMinRemainingUsd.
   * Comma-separated UserRole values, e.g. ADMIN,PROJECT_MANAGER
   */
  billingPowerRoles: (process.env.BILLING_POWER_ROLES ?? 'ADMIN')
    .split(',')
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean),
};

if (!env.databaseUrl) {
  throw new Error('DATABASE_URL is required to run the backend');
}

