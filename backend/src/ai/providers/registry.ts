import { env } from '../../utils/env';
import { GeminiProvider } from './gemini.provider';
import { OpenAIProvider } from './openai.provider';
import { YandexProvider } from './yandex.provider';
import type { AIProvider } from './types';

const providers: Record<string, AIProvider> = {
  gemini: new GeminiProvider(env.geminiApiKey, env.geminiModel),
  openai: new OpenAIProvider(env.openAiApiKey, env.openAiModel),
  yandex: new YandexProvider(env.yandexApiKey, env.yandexModel),
};

export const getProvider = (name?: string, apiKey?: string, yandexFolderId?: string): AIProvider => {
  const normalized = (name ?? env.defaultAIProvider ?? 'gemini').toLowerCase();
  const defaultProvider = providers[normalized] ?? providers.gemini;
  
  // If a custom API key is provided, create a new provider instance with that key
  if (apiKey) {
    const { GeminiProvider } = require('./gemini.provider');
    const { OpenAIProvider } = require('./openai.provider');
    const { YandexProvider } = require('./yandex.provider');
    
    switch (normalized) {
      case 'gemini':
        return new GeminiProvider(apiKey, env.geminiModel);
      case 'openai':
        return new OpenAIProvider(apiKey, env.openAiModel);
      case 'yandex':
        return new YandexProvider(apiKey, env.yandexModel, yandexFolderId);
      default:
        return defaultProvider;
    }
  }
  
  return defaultProvider;
};

export const listProviders = () =>
  Object.keys(providers).map((key) => ({
    name: key,
    defaultModel: providers[key].defaultModel,
    hasApiKey: Boolean(
      (key === 'gemini' && env.geminiApiKey) ||
        (key === 'openai' && env.openAiApiKey) ||
        (key === 'yandex' && env.yandexApiKey),
    ),
  }));







