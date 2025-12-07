import dotenv from 'dotenv';

dotenv.config();

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
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
  defaultAIProvider: (process.env.DEFAULT_AI_PROVIDER ?? 'gemini').toLowerCase(),
  aiBatchSize: numberFromEnv(process.env.AI_BATCH_SIZE, 20),
  aiMaxRetries: numberFromEnv(process.env.AI_MAX_RETRIES, 3),
  azureTranslationEndpoint: process.env.AZURE_TRANSLATION_ENDPOINT ?? '',
  azureTranslationKey: process.env.AZURE_TRANSLATION_KEY ?? '',
  useLibreOffice: process.env.USE_LIBRE_OFFICE === 'true',
  libreOfficePath: process.env.LIBRE_OFFICE_PATH ?? 'libreoffice',
};

if (!env.databaseUrl) {
  throw new Error('DATABASE_URL is required to run the backend');
}

