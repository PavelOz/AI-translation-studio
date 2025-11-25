export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
};

export type ProviderPromptRequest = {
  prompt: string;
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

export interface AIProvider {
  readonly name: string;
  readonly defaultModel: string;
  callModel(request: ProviderPromptRequest): Promise<ProviderPromptResponse>;
}



