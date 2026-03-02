/**
 * ActiveTranslationFeed: Поток сегментов с индикаторами статусов
 * 
 * Индикаторы:
 * - VALIDATED: зеленый чек
 * - AUTO_FIXED: иконка "волшебная палочка"
 * - REQUIRES_REVIEW: мягкий красный цвет с комментарием
 */

import { CheckCircle2, Wand2, AlertCircle, Loader2 } from 'lucide-react';
import type { EnrichedSegment } from '../../utils/segmentMetadata';
import { highlightTerm } from '../../utils/termHighlighting';
import type { JanitorStatus } from '../../api/janitor.api';

interface ActiveTranslationFeedProps {
  segments: EnrichedSegment[];
  selectedTerm: string | null;
  statusFilter: JanitorStatus | 'ALL';
  onStatusFilterChange: (filter: JanitorStatus | 'ALL') => void;
  isLoading: boolean;
}

export default function ActiveTranslationFeed({
  segments,
  selectedTerm,
  statusFilter,
  onStatusFilterChange,
  isLoading,
}: ActiveTranslationFeedProps) {

  const getStatusIndicator = (segment: EnrichedSegment) => {
    const status = segment.janitorStatus || (segment.requiresReview ? 'REQUIRES_REVIEW' : undefined);
    
    switch (status) {
      case 'VALIDATED':
        return (
          <div className="flex items-center gap-2 text-green-600">
            <CheckCircle2 className="w-5 h-5" />
            <span className="text-sm font-medium">Validated</span>
          </div>
        );
      case 'AUTO_FIXED':
        return (
          <div className="flex items-center gap-2 text-blue-600">
            <Wand2 className="w-5 h-5" />
            <span className="text-sm font-medium">Auto-fixed</span>
          </div>
        );
      case 'REQUIRES_REVIEW':
        return (
          <div className="flex items-center gap-2 text-red-600">
            <AlertCircle className="w-5 h-5" />
            <span className="text-sm font-medium">Requires Review</span>
          </div>
        );
      default:
        return null;
    }
  };

  const getSegmentBgColor = (segment: EnrichedSegment) => {
    const status = segment.janitorStatus || (segment.requiresReview ? 'REQUIRES_REVIEW' : undefined);
    
    switch (status) {
      case 'VALIDATED':
        return 'bg-green-50 border-green-200';
      case 'AUTO_FIXED':
        return 'bg-blue-50 border-blue-200';
      case 'REQUIRES_REVIEW':
        return 'bg-red-50 border-red-200';
      default:
        return 'bg-white border-gray-200';
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Filter Bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-700">Filter by status:</span>
          {(['ALL', 'VALIDATED', 'AUTO_FIXED', 'REQUIRES_REVIEW'] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => onStatusFilterChange(filter)}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                statusFilter === filter
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {filter === 'ALL' ? 'All' : filter.replace('_', ' ')}
            </button>
          ))}
        </div>
        <div className="text-sm text-gray-500">
          Showing {segments.length} segment{segments.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Segments List */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="space-y-4 max-w-5xl mx-auto">
          {segments.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              No segments found
            </div>
          ) : (
            segments.map((segment) => (
              <div
                key={segment.id}
                className={`border rounded-lg p-4 transition-all ${
                  selectedTerm && 
                  segment.sourceText.toLowerCase().includes(selectedTerm.toLowerCase())
                    ? 'ring-2 ring-yellow-400 shadow-lg'
                    : ''
                } ${getSegmentBgColor(segment)}`}
              >
                {/* Header: Index and Status */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono text-gray-500">#{segment.segmentIndex}</span>
                    {getStatusIndicator(segment)}
                    {segment.autoCorrected && (
                      <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">
                        Auto-corrected
                      </span>
                    )}
                    {segment.qualityScore !== undefined && (
                      <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                        Score: {segment.qualityScore}/100
                      </span>
                    )}
                  </div>
                </div>

                {/* Source Text */}
                <div className="mb-3">
                  <div className="text-xs font-medium text-gray-500 mb-1">Source</div>
                  <div className="text-gray-900">
                    {highlightTerm(segment.sourceText, selectedTerm)}
                  </div>
                </div>

                {/* Target Text */}
                <div className="mb-3">
                  <div className="text-xs font-medium text-gray-500 mb-1">Target</div>
                  <div className="text-gray-900">
                    {segment.targetFinal || segment.targetMt || (
                      <span className="text-gray-400 italic">Not translated</span>
                    )}
                  </div>
                </div>

                {/* Janitor Comment / Analysis */}
                {(segment.janitorComment || segment.mtAnalysis) && (
                  <div className="mt-3 pt-3 border-t border-gray-200">
                    <div className="text-xs font-medium text-gray-500 mb-1">Notes</div>
                    <div className="text-sm text-gray-700">
                      {segment.janitorComment || segment.mtAnalysis}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
