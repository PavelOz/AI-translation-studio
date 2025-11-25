import type { GlossaryMode } from '../../types/glossary';

interface GlossaryModePanelProps {
  mode: GlossaryMode;
  onModeChange: (mode: GlossaryMode) => void;
}

export default function GlossaryModePanel({ mode, onModeChange }: GlossaryModePanelProps) {
  const handleModeChange = (newMode: GlossaryMode) => {
    onModeChange(newMode);
  };

  return (
    <div className="bg-gray-50 border border-gray-200 rounded p-2 space-y-2">
      <div className="text-xs font-semibold text-gray-700 mb-1">Glossary enforcement</div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => handleModeChange('off')}
          className={`text-[11px] px-2 py-1 rounded border transition-colors ${
            mode === 'off'
              ? 'bg-indigo-600 text-white border-indigo-600'
              : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
          }`}
          title="Glossary is ignored during translation"
        >
          Off
        </button>
        <button
          type="button"
          onClick={() => handleModeChange('strict_source')}
          className={`text-[11px] px-2 py-1 rounded border transition-colors ${
            mode === 'strict_source'
              ? 'bg-indigo-600 text-white border-indigo-600'
              : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
          }`}
          title="Glossary is enforced only when the term appears literally in the source segment"
        >
          Strict (source only)
        </button>
        <button
          type="button"
          onClick={() => handleModeChange('strict_semantic')}
          className={`text-[11px] px-2 py-1 rounded border transition-colors ${
            mode === 'strict_semantic'
              ? 'bg-indigo-600 text-white border-indigo-600'
              : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
          }`}
          title="Semantic/experimental mode (to be implemented)"
        >
          Strict (semantic, experimental)
        </button>
      </div>
    </div>
  );
}

