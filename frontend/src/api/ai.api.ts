import apiClient from './client';
import type { GlossaryMode } from '../types/glossary';

export type AIProvider = {
  name: string;
  defaultModel: string;
};

export type ProjectAISettings = {
  id: string;
  projectId: string;
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  config?: Record<string, unknown>;
};

export type ProjectGuideline = {
  projectId: string;
  rules: Array<{
    title: string;
    description?: string;
    instruction?: string;
  }>;
};

export type UpsertAISettingsRequest = {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  config?: Record<string, unknown>;
  apiKey?: string; // Optional API key to store in config
};

export type TranslateTextRequest = {
  sourceText: string;
  sourceLocale: string;
  targetLocale: string;
  projectId?: string;
  provider?: 'gemini' | 'openai' | 'yandex';
  model?: string;
  temperature?: number;
  maxTokens?: number;
  glossaryMode?: GlossaryMode;
};

export type TranslateTextResponse = {
  targetText: string;
  provider: string;
  model: string;
  confidence: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
};

export type TestCredentialsRequest = {
  provider: 'gemini' | 'openai' | 'yandex';
  apiKey?: string;
};

export type TestCredentialsResponse = {
  success: boolean;
  message: string;
  testResponse?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
  error?: string;
};

export const aiApi = {
  listProviders: async (): Promise<AIProvider[]> => {
    const response = await apiClient.get<AIProvider[]>('/ai/providers');
    return response.data;
  },

  getAISettings: async (projectId: string): Promise<ProjectAISettings | null> => {
    const response = await apiClient.get<ProjectAISettings>(`/ai/projects/${projectId}/ai-settings`);
    return response.data;
  },

  upsertAISettings: async (projectId: string, data: UpsertAISettingsRequest): Promise<ProjectAISettings> => {
    const response = await apiClient.post<ProjectAISettings>(`/ai/projects/${projectId}/ai-settings`, data);
    return response.data;
  },

  getGuidelines: async (projectId: string): Promise<ProjectGuideline> => {
    const response = await apiClient.get<ProjectGuideline>(`/ai/projects/${projectId}/guidelines`);
    return response.data;
  },

  upsertGuidelines: async (projectId: string, rules: ProjectGuideline['rules']): Promise<ProjectGuideline> => {
    const response = await apiClient.post<ProjectGuideline>(`/ai/projects/${projectId}/guidelines`, { rules });
    return response.data;
  },

  translate: async (data: TranslateTextRequest): Promise<TranslateTextResponse> => {
    const response = await apiClient.post<TranslateTextResponse>('/ai/translate', data);
    return response.data;
  },

  testCredentials: async (data: TestCredentialsRequest): Promise<TestCredentialsResponse> => {
    const response = await apiClient.post<TestCredentialsResponse>('/ai/test-credentials', data);
    return response.data;
  },

  // Interactive Critic Workflow - Step 1: Generate Draft
  generateDraft: async (data: {
    sourceText: string;
    projectId?: string;
    sourceLocale?: string;
    targetLocale?: string;
    provider?: string;
    model?: string;
    apiKey?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ draftText: string; modelUsed: string; usage?: any }> => {
    const response = await apiClient.post('/ai/step1-draft', data);
    return response.data;
  },

  // Interactive Critic Workflow - Step 2: Run Critique
  runCritique: async (data: {
    sourceText: string;
    draftText: string;
    projectId?: string;
    sourceLocale?: string;
    targetLocale?: string;
    provider?: string;
    model?: string;
    apiKey?: string;
  }): Promise<{ errors: Array<{ term: string; expected: string; found: string; severity: string }>; reasoning: string; usage?: any }> => {
    const response = await apiClient.post('/ai/step2-critique', data);
    return response.data;
  },

  // Interactive Critic Workflow - Step 3: Fix Translation
  fixTranslation: async (data: {
    sourceText: string;
    draftText: string;
    errors: Array<{ term: string; expected: string; found: string; severity: string }>;
    projectId?: string;
    sourceLocale?: string;
    targetLocale?: string;
    provider?: string;
    model?: string;
    apiKey?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ finalText: string; usage?: any }> => {
    const response = await apiClient.post('/ai/step3-fix', data);
    return response.data;
  },
};


