import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useProjects } from '../hooks/useProjects';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { documentsApi } from '../api/documents.api';
import TMImportModal from '../components/TMImportModal';
import ProjectAISettingsModal from '../components/ProjectAISettingsModal';
import ProjectGuidelinesModal from '../components/ProjectGuidelinesModal';
import { getLanguageName } from '../utils/languages';
import toast from 'react-hot-toast';

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project, delete: deleteProject, isDeleting } = useProjects();
  const projectData = project(projectId!);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    percentage: number;
    loaded: number;
    total: number;
    stage: 'uploading' | 'processing' | 'complete';
    segmentsProcessed?: number;
    totalSegments?: number;
  } | null>(null);
  const [isTmModalOpen, setIsTmModalOpen] = useState(false);
  const [isAISettingsModalOpen, setIsAISettingsModalOpen] = useState(false);
  const [isGuidelinesModalOpen, setIsGuidelinesModalOpen] = useState(false);
  const [segmentationMode, setSegmentationMode] = useState<'paragraphs' | 'sentences'>('paragraphs');
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'importTime'>('importTime');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const { data: documents } = useQuery({
    queryKey: ['documents', projectId],
    queryFn: () => documentsApi.list(projectId),
    enabled: !!projectId,
  });

  const deleteDocumentMutation = useMutation({
    mutationFn: documentsApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents', projectId] });
      toast.success('Document deleted successfully');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to delete document');
    },
  });

  const handleDeleteProject = () => {
    if (window.confirm(`Are you sure you want to delete project "${projectData.data?.name}"? This will also delete all documents in this project. This action cannot be undone.`)) {
      deleteProject(projectId!);
      // Navigate immediately - the mutation will handle the deletion and show success toast
      setTimeout(() => navigate('/projects'), 100);
    }
  };

  const handleDeleteDocument = (documentId: string, documentName: string) => {
    if (window.confirm(`Are you sure you want to delete document "${documentName}"? This action cannot be undone.`)) {
      deleteDocumentMutation.mutate(documentId);
    }
  };

  // Sort documents
  const sortedDocuments = documents ? [...documents].sort((a, b) => {
    let comparison = 0;
    
    switch (sortBy) {
      case 'name':
        comparison = a.name.localeCompare(b.name);
        break;
      case 'size':
        comparison = (a.wordCount || a.totalWords || 0) - (b.wordCount || b.totalWords || 0);
        break;
      case 'importTime':
        comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        break;
    }
    
    return sortOrder === 'asc' ? comparison : -comparison;
  }) : [];

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !projectData.data) return;

    setIsUploading(true);
    setUploadProgress({
      percentage: 0,
      loaded: 0,
      total: file.size,
      stage: 'uploading',
    });

    try {
      // Upload with progress tracking
      const result = await documentsApi.upload(
        {
          projectId: projectId!,
          sourceLocale: projectData.data.sourceLocale,
          targetLocale: projectData.data.targetLocales[0] || projectData.data.sourceLocale,
          file,
          segmentationMode,
        },
        (progress) => {
          // Upload progress (file transfer)
          setUploadProgress({
            percentage: Math.min(progress.percentage, 90), // Reserve 10% for processing
            loaded: progress.loaded,
            total: progress.total,
            stage: 'uploading',
          });
        },
      );

      // Processing stage
      setUploadProgress({
        percentage: 95,
        loaded: file.size,
        total: file.size,
        stage: 'processing',
        segmentsProcessed: result.importedSegments,
        totalSegments: result.importedSegments,
      });

      // Small delay to show processing completion
      await new Promise((resolve) => setTimeout(resolve, 500));

      setUploadProgress({
        percentage: 100,
        loaded: file.size,
        total: file.size,
        stage: 'complete',
        segmentsProcessed: result.importedSegments,
        totalSegments: result.importedSegments,
      });

      queryClient.invalidateQueries({ queryKey: ['documents', projectId] });
      toast.success(`Document uploaded successfully (${result.importedSegments} segments)`);

      // Clear progress after a delay
      setTimeout(() => {
        setUploadProgress(null);
      }, 2000);
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to upload document');
      setUploadProgress(null);
    } finally {
      setIsUploading(false);
      e.target.value = ''; // Reset input
    }
  };

  if (projectData.isLoading) {
    return (
      <Layout>
        <div className="text-center">Loading...</div>
      </Layout>
    );
  }

  if (!projectData.data) {
    return (
      <Layout>
        <div className="text-center">Project not found</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{projectData.data.name}</h1>
            <p className="text-gray-600 mt-2">{projectData.data.description}</p>
          </div>
          <button
            onClick={handleDeleteProject}
            disabled={isDeleting}
            className="btn btn-danger text-sm"
          >
            {isDeleting ? 'Deleting...' : 'Delete Project'}
          </button>
        </div>

        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">AI Settings</h2>
            <button
              onClick={() => setIsAISettingsModalOpen(true)}
              className="btn btn-primary"
            >
              Configure AI
            </button>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            Configure AI provider (OpenAI ChatGPT, Google Gemini, Yandex GPT) and API credentials for this project.
          </p>
        </div>

        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">Translation Guidelines</h2>
            <button
              onClick={() => setIsGuidelinesModalOpen(true)}
              className="btn btn-primary"
            >
              View Guidelines
            </button>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            View and manage translation rules that are automatically applied to all AI translations in this project.
            Rules saved from chat conversations appear here.
          </p>
        </div>

        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">Translation Memory</h2>
            <button
              onClick={() => setIsTmModalOpen(true)}
              className="btn btn-primary"
            >
              Import TMX
            </button>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            Import translation memory from external TMX files to improve translation suggestions.
          </p>
        </div>

        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">Documents</h2>
            <div className="flex items-center gap-3">
              {/* Sort Controls */}
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600">Sort by:</label>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as 'name' | 'size' | 'importTime')}
                  className="text-sm border border-gray-300 rounded px-2 py-1 bg-white"
                >
                  <option value="name">Name</option>
                  <option value="size">Size</option>
                  <option value="importTime">Import Time</option>
                </select>
                <button
                  onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                  className="text-sm text-gray-600 hover:text-gray-900"
                  title={sortOrder === 'asc' ? 'Ascending' : 'Descending'}
                >
                  {sortOrder === 'asc' ? '↑' : '↓'}
                </button>
              </div>
              <label className="btn btn-primary cursor-pointer">
                {isUploading ? 'Uploading...' : '+ Upload Document'}
                <input
                  type="file"
                  className="hidden"
                  accept=".docx,.xlsx,.xliff,.xlf"
                  onChange={handleFileUpload}
                  disabled={isUploading}
                />
              </label>
            </div>
          </div>
          
          {/* Segmentation Mode Selection */}
          <div className="mb-4 p-3 bg-gray-50 rounded-lg">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Segmentation Mode
            </label>
            <div className="flex gap-4">
              <label className="flex items-center">
                <input
                  type="radio"
                  value="paragraphs"
                  checked={segmentationMode === 'paragraphs'}
                  onChange={(e) => setSegmentationMode(e.target.value as 'paragraphs' | 'sentences')}
                  className="mr-2"
                />
                <span className="text-sm text-gray-700">By Paragraphs</span>
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  value="sentences"
                  checked={segmentationMode === 'sentences'}
                  onChange={(e) => setSegmentationMode(e.target.value as 'paragraphs' | 'sentences')}
                  className="mr-2"
                />
                <span className="text-sm text-gray-700">By Sentences</span>
              </label>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {segmentationMode === 'paragraphs' 
                ? 'Documents will be split by paragraphs (recommended for most documents)'
                : 'Documents will be split by sentences (useful for detailed editing and alignment)'}
            </p>
>>>>>>> 500edc9 (Add document sorting and import time display; Fix export for sentence-segmented documents)
          </div>
          
          {/* Upload Progress Bar */}
          {uploadProgress && (
            <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-medium text-blue-900">
                  {uploadProgress.stage === 'uploading' && 'Uploading file...'}
                  {uploadProgress.stage === 'processing' && 'Processing segments...'}
                  {uploadProgress.stage === 'complete' && 'Upload complete!'}
                </span>
                <span className="text-sm text-blue-700">
                  {uploadProgress.percentage}%
                </span>
              </div>
              <div className="w-full bg-blue-200 rounded-full h-2.5 mb-2">
                <div
                  className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress.percentage}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-blue-600">
                <span>
                  {uploadProgress.stage === 'uploading' && (
                    <>
                      {((uploadProgress.loaded / 1024 / 1024).toFixed(2))} MB /{' '}
                      {((uploadProgress.total / 1024 / 1024).toFixed(2))} MB
                    </>
                  )}
                  {uploadProgress.stage === 'processing' && uploadProgress.segmentsProcessed && (
                    <>Processing {uploadProgress.segmentsProcessed} segments...</>
                  )}
                  {uploadProgress.stage === 'complete' && uploadProgress.segmentsProcessed && (
                    <>✓ {uploadProgress.segmentsProcessed} segments imported</>
                  )}
                </span>
                {uploadProgress.stage === 'uploading' && (
                  <span>
                    {uploadProgress.total > 0 &&
                      `${((uploadProgress.loaded / uploadProgress.total) * 100).toFixed(1)}%`}
                  </span>
                )}
              </div>
            </div>
          )}
          
          {sortedDocuments && sortedDocuments.length > 0 ? (
            <div className="space-y-2">
              {sortedDocuments.map((doc) => (
                <div key={doc.id} className="border-b border-gray-200 pb-3 flex justify-between items-center">
                  <div>
                    <Link
                      to={`/documents/${doc.id}`}
                      className="text-primary-600 hover:underline font-medium"
                    >
                      {doc.name}
                    </Link>
                    <div className="text-sm text-gray-500 mt-1">
                      {getLanguageName(doc.sourceLocale)} → {getLanguageName(doc.targetLocale)} • {doc.totalSegments} segments • {(doc.wordCount || doc.totalWords || 0).toLocaleString()} words
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      Imported: {new Date(doc.createdAt).toLocaleString()}
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      Imported: {formatImportDate(doc.createdAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      doc.status === 'COMPLETED' ? 'bg-green-100 text-green-800' :
                      doc.status === 'IN_PROGRESS' ? 'bg-blue-100 text-blue-800' :
                      'bg-gray-100 text-gray-800'
                    }`}>
                      {doc.status}
                    </span>
                    <Link
                      to={`/documents/${doc.id}/editor`}
                      className="btn btn-primary text-sm"
                    >
                      Open Editor
                    </Link>
                    <button
                      onClick={() => handleDeleteDocument(doc.id, doc.name)}
                      disabled={deleteDocumentMutation.isPending}
                      className="btn btn-danger text-sm"
                      title="Delete document"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500 mb-4">No documents yet</p>
              <label className="btn btn-primary cursor-pointer">
                {isUploading ? 'Uploading...' : 'Upload Your First Document'}
                <input
                  type="file"
                  className="hidden"
                  accept=".docx,.xlsx,.xliff,.xlf"
                  onChange={handleFileUpload}
                  disabled={isUploading}
                />
              </label>
              <p className="text-xs text-gray-400 mt-2">
                Supported formats: DOCX, XLSX, XLIFF
              </p>
              
              {/* Upload Progress Bar for empty state */}
              {uploadProgress && (
                <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg max-w-md mx-auto">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-blue-900">
                      {uploadProgress.stage === 'uploading' && 'Uploading file...'}
                      {uploadProgress.stage === 'processing' && 'Processing segments...'}
                      {uploadProgress.stage === 'complete' && 'Upload complete!'}
                    </span>
                    <span className="text-sm text-blue-700">
                      {uploadProgress.percentage}%
                    </span>
                  </div>
                  <div className="w-full bg-blue-200 rounded-full h-2.5 mb-2">
                    <div
                      className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                      style={{ width: `${uploadProgress.percentage}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-blue-600">
                    <span>
                      {uploadProgress.stage === 'uploading' && (
                        <>
                          {((uploadProgress.loaded / 1024 / 1024).toFixed(2))} MB /{' '}
                          {((uploadProgress.total / 1024 / 1024).toFixed(2))} MB
                        </>
                      )}
                      {uploadProgress.stage === 'processing' && uploadProgress.segmentsProcessed && (
                        <>Processing {uploadProgress.segmentsProcessed} segments...</>
                      )}
                      {uploadProgress.stage === 'complete' && uploadProgress.segmentsProcessed && (
                        <>✓ {uploadProgress.segmentsProcessed} segments imported</>
                      )}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <TMImportModal
          isOpen={isTmModalOpen}
          onClose={() => setIsTmModalOpen(false)}
          projectId={projectId}
          onSuccess={() => {
            // Optionally refresh TM data if needed
          }}
        />

            <ProjectAISettingsModal
              isOpen={isAISettingsModalOpen}
              onClose={() => setIsAISettingsModalOpen(false)}
              projectId={projectId!}
            />

            <ProjectGuidelinesModal
              isOpen={isGuidelinesModalOpen}
              onClose={() => setIsGuidelinesModalOpen(false)}
              projectId={projectId!}
            />
          </div>
        </Layout>
      );
    }

