import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { chatApi, type ChatMessage } from '../../api/chat.api';
import toast from 'react-hot-toast';

interface AIChatPanelProps {
  projectId: string;
  documentId?: string;
  segmentId?: string;
  sourceText?: string;
  targetText?: string;
}

export default function AIChatPanel({
  projectId,
  documentId,
  segmentId,
  sourceText,
  targetText,
}: AIChatPanelProps) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatAbortControllerRef = useRef<AbortController | null>(null);

  const queryClient = useQueryClient();

  const { data: chatHistory, isLoading } = useQuery(
    ['chat-history', projectId, documentId, segmentId],
    () => chatApi.getHistory(projectId, { documentId, segmentId, limit: 50 }),
    {
      enabled: !!projectId,
      refetchOnWindowFocus: false,
    },
  );

  const sendMessageMutation = useMutation({
    mutationFn: (msg: string) =>
      chatApi.sendMessage(
        {
          projectId,
          documentId,
          segmentId,
          message: msg,
        },
        chatAbortControllerRef.current?.signal,
      ),
    onSuccess: (response) => {
      // Check if rules were extracted
      if (response.metadata?.extractedRules && response.metadata.extractedRules.length > 0) {
        toast.success(
          `AI suggested ${response.metadata.extractedRules.length} rule(s). Click to save them to project guidelines.`,
          {
            duration: 5000,
            icon: '💡',
          },
        );
      }
      // Refetch chat history to show the new messages
      queryClient.invalidateQueries(['chat-history', projectId, documentId, segmentId]);
      // Scroll to bottom after a short delay to ensure messages are rendered
      setTimeout(() => {
        scrollToBottom();
      }, 100);
    },
    onError: (error: any) => {
      if (error.name !== 'AbortError') {
        toast.error(error.response?.data?.message || 'Failed to send message');
      }
    },
  });

  const saveRulesMutation = useMutation({
    mutationFn: (rules: string[]) => chatApi.saveRules(projectId, rules),
    onSuccess: () => {
      toast.success('Rules saved to project guidelines');
      queryClient.invalidateQueries(['ai-guidelines', projectId]);
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to save rules');
    },
  });

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [chatHistory, scrollToBottom]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || isSending) return;

    const messageToSend = message.trim();
    setMessage('');
    setIsSending(true);

    // Cancel any pending request
    if (chatAbortControllerRef.current) {
      chatAbortControllerRef.current.abort();
    }

    // Create new AbortController
    chatAbortControllerRef.current = new AbortController();

    try {
      await sendMessageMutation.mutateAsync(messageToSend);
    } finally {
      setIsSending(false);
    }
  };

  const handleSaveRules = (rules: string[]) => {
    if (rules.length === 0) return;
    if (confirm(`Save ${rules.length} rule(s) to project guidelines?`)) {
      saveRulesMutation.mutate(rules);
    }
  };

  const handleQuickMessage = (quickMsg: string) => {
    setMessage(quickMsg);
  };

  const messages: ChatMessage[] = chatHistory || [];

  return (
    <div
      className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col h-full max-h-[600px]"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-semibold text-gray-900">AI Translation Assistant</h3>
        <span className="text-xs text-gray-500">
          {documentId ? 'Document context' : 'Project context'}
        </span>
      </div>

      {/* Quick message buttons */}
      <div className="mb-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => handleQuickMessage('What translation style should I use for this document?')}
          className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-700"
          disabled={isSending}
        >
          Style?
        </button>
        {sourceText && (
          <button
            type="button"
            onClick={() => handleQuickMessage(`How should I translate: "${sourceText.substring(0, 50)}..."?`)}
            className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-700"
            disabled={isSending}
          >
            Help translate
          </button>
        )}
        <button
          type="button"
          onClick={() => handleQuickMessage('What are the key translation rules for this project?')}
          className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-700"
          disabled={isSending}
        >
          Rules?
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto mb-3 space-y-3 min-h-[200px] max-h-[400px]">
        {isLoading && !chatHistory ? (
          <div className="text-center text-gray-500 text-sm py-4">Loading chat history...</div>
        ) : messages.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-4">
            Start a conversation with the AI assistant about translation rules, style, or specific segments.
          </div>
        ) : (
          <>
            {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 ${
                  msg.role === 'user'
                    ? 'bg-primary-600 text-white'
                    : 'bg-gray-100 text-gray-900'
                }`}
              >
                <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
                {msg.metadata?.extractedRules && msg.metadata.extractedRules.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-gray-300">
                    <div className="text-xs font-semibold mb-1">Suggested Rules:</div>
                    <ul className="text-xs space-y-1 mb-2">
                      {msg.metadata.extractedRules.map((rule, idx) => (
                        <li key={idx}>• {rule}</li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={() => handleSaveRules(msg.metadata!.extractedRules!)}
                      className="text-xs px-2 py-1 bg-primary-600 text-white rounded hover:bg-primary-700"
                      disabled={saveRulesMutation.isPending}
                    >
                      {saveRulesMutation.isPending ? 'Saving...' : 'Save Rules'}
                    </button>
                  </div>
                )}
              </div>
            </div>
            ))}
            {isSending && (
              <div className="flex justify-start">
                <div className="bg-gray-100 text-gray-900 rounded-lg px-3 py-2 max-w-[80%]">
                  <div className="text-sm flex items-center gap-2">
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-400 border-t-transparent"></div>
                    <span>AI is thinking...</span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="flex gap-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend(e);
            }
          }}
          placeholder="Ask about translation rules, style, or get help with a segment..."
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-sm resize-none"
          rows={2}
          disabled={isSending}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
        <button
          type="submit"
          disabled={!message.trim() || isSending}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
        >
          {isSending ? '...' : 'Send'}
        </button>
      </form>
    </div>
  );
}

