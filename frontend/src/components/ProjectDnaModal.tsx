import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { projectsApi } from '../api/projects.api';
import type { DocumentDnaPayload } from '../api/analysis.api';
import { DocumentDnaEditor } from './DocumentDnaEditor';
import toast from 'react-hot-toast';

type ProjectDnaModalProps = {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
};

function emptyPayload(): DocumentDnaPayload {
  return {
    technicalSchema: null,
    namingConventions: null,
    abbreviationLogic: null,
    entityGroups: null,
  };
}

export default function ProjectDnaModal({ isOpen, onClose, projectId }: ProjectDnaModalProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DocumentDnaPayload>(emptyPayload());

  const { data: dna, isLoading } = useQuery(
    ['project-dna', projectId],
    () => projectsApi.getProjectDna(projectId),
    { enabled: isOpen && !!projectId },
  );

  useEffect(() => {
    if (!isOpen) return;
    if (dna) {
      setDraft({
        technicalSchema: dna.technicalSchema ?? null,
        namingConventions: dna.namingConventions ?? null,
        abbreviationLogic: dna.abbreviationLogic ?? null,
        entityGroups: dna.entityGroups ?? null,
      });
    } else if (!isLoading) {
      setDraft(emptyPayload());
    }
  }, [isOpen, dna, isLoading]);

  const saveMutation = useMutation({
    mutationFn: (payload: DocumentDnaPayload) => projectsApi.updateProjectDna(projectId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-dna', projectId] });
      toast.success('Project DNA saved');
    },
    onError: (error: unknown) => {
      const err = error as { response?: { data?: { error?: string; details?: string[] } } };
      const msg =
        err.response?.data?.details?.join('; ') ||
        err.response?.data?.error ||
        'Failed to save project DNA';
      toast.error(msg);
    },
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-4xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Project DNA defaults</h2>
            <p className="text-sm text-gray-600 mt-1 max-w-2xl">
              Optional terminology and schema shared by all documents in this project. Document-level DNA overrides
              these fields when both are set. AI translation and DNA validation use the merged effective DNA.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            disabled={saveMutation.isLoading}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {isLoading ? (
          <div className="text-center py-8 text-gray-600">Loading…</div>
        ) : (
          <>
            <DocumentDnaEditor dna={draft} onChange={setDraft} disabled={saveMutation.isLoading} />
            <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-200">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saveMutation.isLoading}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={saveMutation.isLoading}
                onClick={() => saveMutation.mutate(draft)}
              >
                {saveMutation.isLoading ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
