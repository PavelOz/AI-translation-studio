/**
 * ProjectHeader: Заголовок проекта с названием, тегами и статус-баром здоровья
 */

import { type Document } from '../../api/documents.api';
import { CheckCircle2, AlertCircle, TrendingUp, TrendingDown } from 'lucide-react';

interface ProjectHeaderProps {
  document: Document;
  health: {
    score: number;
    status: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';
    validated: number;
    autoFixed: number;
    requiresReview: number;
    total: number;
  };
  tags: string[];
}

export default function ProjectHeader({ document, health, tags }: ProjectHeaderProps) {
  const getHealthColor = () => {
    switch (health.status) {
      case 'excellent': return 'bg-green-500';
      case 'good': return 'bg-blue-500';
      case 'fair': return 'bg-yellow-500';
      case 'poor': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };

  const getHealthIcon = () => {
    switch (health.status) {
      case 'excellent':
      case 'good':
        return <CheckCircle2 className="w-5 h-5 text-white" />;
      case 'fair':
      case 'poor':
        return <AlertCircle className="w-5 h-5 text-white" />;
      default:
        return null;
    }
  };

  return (
    <div className="bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-full mx-auto px-6 py-4">
        <div className="flex items-center justify-between">
          {/* Left: Document Name and Tags */}
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-gray-900 mb-2">{document.name}</h1>
            <div className="flex items-center gap-2">
              {tags.length > 0 ? (
                <>
                  <span className="text-sm text-gray-500">Tags:</span>
                  {tags.map((tag, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
                    >
                      {tag}
                    </span>
                  ))}
                </>
              ) : (
                <span className="text-sm text-gray-400">No tags</span>
              )}
            </div>
          </div>

          {/* Right: Health Status Bar */}
          <div className="flex items-center gap-6">
            {/* Health Score */}
            <div className="text-right">
              <div className="text-sm text-gray-500 mb-1">Document Health</div>
              <div className="flex items-center gap-2">
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${getHealthColor()}`}>
                  {getHealthIcon()}
                  <span className="text-white font-semibold">{health.score}/100</span>
                </div>
                {health.status === 'excellent' || health.status === 'good' ? (
                  <TrendingUp className="w-5 h-5 text-green-500" />
                ) : (
                  <TrendingDown className="w-5 h-5 text-red-500" />
                )}
              </div>
            </div>

            {/* Statistics */}
            <div className="flex items-center gap-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">{health.validated}</div>
                <div className="text-xs text-gray-500">Validated</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">{health.autoFixed}</div>
                <div className="text-xs text-gray-500">Auto-fixed</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-red-600">{health.requiresReview}</div>
                <div className="text-xs text-gray-500">Review</div>
              </div>
              <div className="text-center border-l pl-4">
                <div className="text-2xl font-bold text-gray-900">{health.total}</div>
                <div className="text-xs text-gray-500">Total</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
