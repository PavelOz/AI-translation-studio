import { useState } from 'react';
import AnalysisSidebar from '../AnalysisSidebar';
import DocumentGlossary from '../DocumentGlossary';
import GuidelinesPanel from './GuidelinesPanel';
import AIChatPanel from './AIChatPanel';
import AITranslationPanel from './AITranslationPanel';
import TMSuggestionsPanel from './TMSuggestionsPanel';
import GlossaryModePanel from './GlossaryModePanel';
import GlossaryPanel from './GlossaryPanel';
import QAIssuesPanel from './QAIssuesPanel';
import AnalysisInspector from './AnalysisInspector';
import DebugInspectorPanel from './DebugInspectorPanel';
import type { GlossaryMode } from '../../types/glossary';

export type SidebarTabId = 'context' | 'tools' | 'qa' | 'debug';

export interface SidebarTabsProps {
  documentId: string;
  projectId: string;
  sourceLocale: string;
  targetLocale: string;
  segmentId: string;
  sourceText: string;
  targetText: string;
  /** TM row that was applied for this segment (pretranslate / direct TM); panel pins it above scatter-gather. */
  appliedBestTmEntryId?: string | null;
  appliedTmScore?: number | null;
  glossaryMode: GlossaryMode;
  onGlossaryModeChange: (mode: GlossaryMode) => void;
  onApplyTM: (targetText: string) => void;
}

const tabConfig: Array<{ id: SidebarTabId; label: string; title: string }> = [
  { id: 'context', label: 'Context', title: 'DNA & context' },
  { id: 'tools', label: 'Tools', title: 'Translation tools' },
  { id: 'qa', label: 'QA', title: 'Quality & glossary' },
  { id: 'debug', label: 'Debug', title: 'Debug & analysis' },
];

function IconContext() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

function IconTools() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function IconQA() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  );
}

function IconDebug() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
    </svg>
  );
}

function TabIcon({ id }: { id: SidebarTabId }) {
  switch (id) {
    case 'context':
      return <IconContext />;
    case 'tools':
      return <IconTools />;
    case 'qa':
      return <IconQA />;
    case 'debug':
      return <IconDebug />;
    default:
      return null;
  }
}

export default function SidebarTabs(props: SidebarTabsProps) {
  const {
    documentId,
    projectId,
    sourceLocale,
    targetLocale,
    segmentId,
    sourceText,
    targetText,
    appliedBestTmEntryId,
    appliedTmScore,
    glossaryMode,
    onGlossaryModeChange,
    onApplyTM,
  } = props;

  const [activeTab, setActiveTab] = useState<SidebarTabId>('context');

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar */}
      <div className="flex-shrink-0 flex border-b border-gray-200 bg-white">
        {tabConfig.map(({ id, label, title }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            title={title}
            className={`flex-1 flex flex-col items-center justify-center py-2.5 px-1 text-xs font-medium transition-colors ${
              activeTab === id
                ? 'text-primary-600 border-b-2 border-primary-600 bg-primary-50/50'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50 border-b-2 border-transparent'
            }`}
          >
            <span className="mb-0.5">
              <TabIcon id={id} />
            </span>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Single scrollable content area */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {activeTab === 'context' && (
          <>
            <AnalysisSidebar documentId={documentId} />
            <GuidelinesPanel projectId={projectId} />
            <DocumentGlossary documentId={documentId} />
          </>
        )}

        {activeTab === 'tools' && (
          <>
            <AIChatPanel
              projectId={projectId}
              documentId={documentId}
              segmentId={segmentId}
              sourceText={sourceText}
              targetText={targetText}
            />
            <AITranslationPanel
              sourceText={sourceText}
              sourceLocale={sourceLocale}
              targetLocale={targetLocale}
              projectId={projectId}
              segmentId={segmentId}
              glossaryMode={glossaryMode}
              currentTargetText={targetText}
              onApply={onApplyTM}
            />
            <TMSuggestionsPanel
              sourceText={sourceText}
              sourceLocale={sourceLocale}
              targetLocale={targetLocale}
              projectId={projectId}
              segmentId={segmentId}
              currentTargetText={targetText}
              appliedBestTmEntryId={appliedBestTmEntryId}
              appliedTmScore={appliedTmScore}
              onApply={onApplyTM}
            />
          </>
        )}

        {activeTab === 'qa' && (
          <>
            <GlossaryModePanel
              mode={glossaryMode}
              onModeChange={(mode) => {
                onGlossaryModeChange(mode);
                if (typeof window !== 'undefined') {
                  try {
                    localStorage.setItem('ai-ts-glossary-mode', mode);
                  } catch {
                    // ignore
                  }
                }
              }}
            />
            <GlossaryPanel
              sourceText={sourceText}
              sourceLocale={sourceLocale}
              targetLocale={targetLocale}
              projectId={projectId}
            />
            <QAIssuesPanel segmentId={segmentId} />
          </>
        )}

        {activeTab === 'debug' && (
          <>
            <AnalysisInspector segmentId={segmentId} />
            <DebugInspectorPanel segmentId={segmentId} />
          </>
        )}
      </div>
    </div>
  );
}
