import apiClient from './client';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  metadata?: {
    extractedRules?: string[];
  };
};

export type SendChatMessageRequest = {
  projectId: string;
  documentId?: string;
  segmentId?: string;
  message: string;
};

export type GetChatHistoryParams = {
  documentId?: string;
  segmentId?: string;
  limit?: number;
};

export type SaveRulesRequest = {
  rules: string[];
};

export const chatApi = {
  sendMessage: async (data: SendChatMessageRequest, signal?: AbortSignal): Promise<ChatMessage> => {
    const response = await apiClient.post<ChatMessage>(
      `/chat/projects/${data.projectId}/chat`,
      {
        documentId: data.documentId,
        segmentId: data.segmentId,
        message: data.message,
      },
      { signal },
    );
    return response.data;
  },

  getHistory: async (
    projectId: string,
    params?: GetChatHistoryParams,
    signal?: AbortSignal,
  ): Promise<ChatMessage[]> => {
    const response = await apiClient.get<ChatMessage[]>(`/chat/projects/${projectId}/chat`, {
      params,
      signal,
    });
    return response.data;
  },

  saveRules: async (projectId: string, rules: string[]): Promise<{ success: boolean; message: string }> => {
    const response = await apiClient.post<{ success: boolean; message: string }>(
      `/chat/projects/${projectId}/chat/save-rules`,
      { rules },
    );
    return response.data;
  },
};



