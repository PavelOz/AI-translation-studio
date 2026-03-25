import { env } from '../../utils/env';
import { GeminiProvider } from './gemini.provider';
import { OpenAIProvider } from './openai.provider';
import { YandexProvider } from './yandex.provider';
import { DeepSeekProvider } from './deepseek.provider';
import type { AIProvider } from './types';
import { wrapProviderInstanceWithBilling } from './billingWrappedProvider';

const wrap = <T extends AIProvider>(p: T) => wrapProviderInstanceWithBilling(p);

const providers: Record<string, AIProvider> = {
  gemini: wrap(new GeminiProvider(env.geminiApiKey, env.geminiModel)),
  openai: wrap(new OpenAIProvider(env.openAiApiKey, env.openAiModel)),
  yandex: wrap(new YandexProvider(env.yandexApiKey, env.yandexModel)),
  deepseek: wrap(new DeepSeekProvider(env.deepseekApiKey, env.deepseekModel)),
};

export const getProvider = (name?: string, apiKey?: string, yandexFolderId?: string): AIProvider => {
  const normalized = (name ?? env.defaultAIProvider ?? 'gemini').toLowerCase();
  const defaultProvider = providers[normalized] ?? providers.gemini;
  
  // If a custom API key is provided, create a new provider instance with that key
  if (apiKey) {
    const { GeminiProvider } = require('./gemini.provider');
    const { OpenAIProvider } = require('./openai.provider');
    const { YandexProvider } = require('./yandex.provider');
    const { DeepSeekProvider } = require('./deepseek.provider');
    
    switch (normalized) {
      case 'gemini':
        return wrap(new GeminiProvider(apiKey, env.geminiModel));
      case 'openai':
        return wrap(new OpenAIProvider(apiKey, env.openAiModel));
      case 'yandex':
        return wrap(new YandexProvider(apiKey, env.yandexModel, yandexFolderId));
      case 'deepseek':
        return wrap(new DeepSeekProvider(apiKey, env.deepseekModel));
      default:
        return defaultProvider;
    }
  }
  
  return defaultProvider;
};

export const listProviders = () => {
  const providerList = Object.keys(providers).map((key) => ({
    name: key,
    defaultModel: providers[key].defaultModel,
    hasApiKey: Boolean(
      (key === 'gemini' && env.geminiApiKey) ||
        (key === 'openai' && env.openAiApiKey) ||
        (key === 'yandex' && env.yandexApiKey) ||
        (key === 'deepseek' && env.deepseekApiKey),
    ),
  }));
  
  // Add Claude even though it's not fully implemented yet
  // This allows the UI to work and save Claude settings
  providerList.push({
    name: 'claude',
    defaultModel: 'claude-sonnet-4-20250514',
    hasApiKey: Boolean(env.claudeApiKey),
  });
  
  return providerList;
};







