export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
};

export type ProviderPromptRequest = {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  segments: Array<{
    segmentId: string;
    sourceText: string;
  }>;
};

export type ProviderPromptResponse = {
  outputText: string;
  usage?: ProviderUsage;
  raw?: unknown;
};

/**
 * Возможности модели провайдера
 */
export interface ModelCapabilities {
  maxBatchSize: number; // Максимальное количество терминов в одном батче
  contextLimit: number; // Максимальный контекст в токенах
  supportsBatchProcessing: boolean; // Поддерживает ли батч-обработку
}

export interface AIProvider {
  readonly name: string;
  readonly defaultModel: string;
  callModel(request: ProviderPromptRequest): Promise<ProviderPromptResponse>;
  getCapabilities(model?: string): ModelCapabilities;
}



