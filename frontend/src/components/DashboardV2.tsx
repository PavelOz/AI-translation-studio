/**
 * DashboardV2: Новый интерфейс для управления переводом с DNA
 * 
 * Компоненты:
 * - ProjectHeader: Название документа, теги, статус здоровья
 * - DnaSidebar: Интерактивная панель с abbreviationLogic
 * - ActiveTranslationFeed: Поток сегментов с индикаторами статусов
 * - ControlPanel: Кнопка Run Full Cycle и выбор моделей
 */

import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from 'react-query';
import Layout from './Layout';
import { documentsApi } from '../api/documents.api';
import { janitorApi, type JanitorStatus } from '../api/janitor.api';
import { analysisApi } from '../api/analysis.api';
import { useEnrichedSegments } from '../hooks/useEnrichedSegments';
import { Loader2 } from 'lucide-react';

// Компоненты
import ProjectHeader from './dashboard-v2/ProjectHeader';
import DnaSidebar from './dashboard-v2/DnaSidebar';
import ActiveTranslationFeed from './dashboard-v2/ActiveTranslationFeed';
import ControlPanel from './dashboard-v2/ControlPanel';

export default function DashboardV2() {
  const { documentId } = useParams<{ documentId: string }>();
  const queryClient = useQueryClient();
  
  const [selectedTerm, setSelectedTerm] = useState<string | null>(null);
  const [isDnaSidebarOpen, setIsDnaSidebarOpen] = useState(true);
  const [statusFilter, setStatusFilter] = useState<JanitorStatus | 'ALL'>('ALL');
  const [documentTags, setDocumentTags] = useState<string[]>([]); // TODO: Получить из документа или API

  // Загружаем документ
  const { data: document, isLoading: isLoadingDocument } = useQuery({
    queryKey: ['documents', documentId],
    queryFn: () => documentsApi.get(documentId!),
    enabled: !!documentId,
  });

  // Используем хук для обогащенных сегментов
  const {
    segments: enrichedSegments,
    isLoading: isLoadingSegments,
    error: segmentsError,
    documentHealth,
    statistics,
  } = useEnrichedSegments({
    documentId: documentId!,
    enabled: !!documentId,
    page: 1,
    pageSize: 1000,
  });

  // Загружаем DNA
  const { data: dna, isLoading: isLoadingDna } = useQuery({
    queryKey: ['document-dna', documentId],
    queryFn: () => analysisApi.getDocumentDna(documentId!),
    enabled: !!documentId && isDnaSidebarOpen,
    retry: false,
  });

  // Фильтруем сегменты по статусу
  const filteredSegments = useMemo(() => {
    if (!enrichedSegments) return [];
    if (statusFilter === 'ALL') return enrichedSegments;
    return enrichedSegments.filter(seg => seg.janitorStatus === statusFilter);
  }, [enrichedSegments, statusFilter]);

  if (isLoadingDocument || isLoadingSegments || !document) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
        </div>
      </Layout>
    );
  }

  // Показываем ошибку, если есть
  if (segmentsError) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <p className="text-red-600 mb-2">Error loading segments</p>
            <p className="text-sm text-gray-500">{segmentsError.message}</p>
          </div>
        </div>
      </Layout>
    );
  }

  // Отладочная информация (можно удалить после проверки)
  console.log('DashboardV2 Debug:', {
    documentId,
    document: document?.name,
    enrichedSegmentsCount: enrichedSegments?.length || 0,
    filteredSegmentsCount: filteredSegments?.length || 0,
    documentHealth,
    isLoadingSegments,
  });

  return (
    <Layout>
      <div className="min-h-screen bg-gray-50">
        {/* Project Header */}
        <ProjectHeader
          document={document}
          health={documentHealth || {
            score: 0,
            status: 'unknown',
            validated: 0,
            autoFixed: 0,
            requiresReview: 0,
            total: enrichedSegments?.length || 0,
          }}
          tags={documentTags}
        />

        <div className="flex h-[calc(100vh-120px)]">
          {/* Main Content */}
          <div className={`flex-1 flex flex-col transition-all duration-300 ${
            isDnaSidebarOpen ? 'mr-80' : ''
          }`}>
            {/* Control Panel */}
            <ControlPanel
              documentId={documentId!}
              tags={documentTags}
              onTagsChange={setDocumentTags}
              onFullCycleComplete={() => {
                queryClient.invalidateQueries(['segments', documentId]);
                queryClient.invalidateQueries(['janitor-report', documentId]);
                queryClient.invalidateQueries(['document-dna', documentId]);
              }}
            />

            {/* Active Translation Feed */}
            <div className="flex-1 overflow-hidden">
              <ActiveTranslationFeed
                segments={filteredSegments}
                selectedTerm={selectedTerm}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                isLoading={isLoadingSegments}
              />
            </div>
          </div>

          {/* DNA Sidebar */}
          <DnaSidebar
            dna={dna}
            isOpen={isDnaSidebarOpen}
            onToggle={() => setIsDnaSidebarOpen(!isDnaSidebarOpen)}
            selectedTerm={selectedTerm}
            onTermSelect={setSelectedTerm}
            isLoading={isLoadingDna}
          />
        </div>
      </div>
    </Layout>
  );
}
