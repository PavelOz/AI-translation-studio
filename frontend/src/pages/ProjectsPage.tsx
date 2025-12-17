import { useState } from 'react';
import Layout from '../components/Layout';
import { useProjects } from '../hooks/useProjects';
import { Link, useNavigate } from 'react-router-dom';
import ProjectCreateModal from '../components/ProjectCreateModal';
import type { CreateProjectRequest } from '../api/projects.api';

export default function ProjectsPage() {
  const { projects, isLoading, create, isCreating, delete: deleteProject, isDeleting } = useProjects();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const navigate = useNavigate();

  const handleCreate = (data: CreateProjectRequest) => {
    create(data);
    setIsModalOpen(false);
  };

  const handleDelete = (projectId: string, projectName: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (window.confirm(`Are you sure you want to delete project "${projectName}"? This will delete all associated documents, translations, and data. This action cannot be undone.`)) {
      deleteProject(projectId);
    }
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="text-center py-12">Loading...</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold text-gray-900">Projects</h1>
          <button
            onClick={() => setIsModalOpen(true)}
            className="btn btn-primary"
          >
            + New Project
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="card text-center py-12">
            <p className="text-gray-500 mb-4">No projects yet</p>
            <button
              onClick={() => setIsModalOpen(true)}
              className="btn btn-primary"
            >
              Create Your First Project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map((project) => (
              <div key={project.id} className="card hover:shadow-lg transition-shadow relative">
                <Link
                  to={`/projects/${project.id}`}
                  className="block"
                >
                  <h3 className="text-lg font-semibold text-gray-900 mb-2 pr-8">{project.name}</h3>
                  <p className="text-sm text-gray-600 mb-4">{project.description || 'No description'}</p>
                  <div className="flex justify-between items-center">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      project.status === 'COMPLETED' ? 'bg-green-100 text-green-800' :
                      project.status === 'IN_PROGRESS' ? 'bg-blue-100 text-blue-800' :
                      'bg-gray-100 text-gray-800'
                    }`}>
                      {project.status}
                    </span>
                    <span className="text-xs text-gray-500">
                      {project.targetLocales.length} locale{project.targetLocales.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </Link>
                <button
                  onClick={(e) => handleDelete(project.id, project.name, e)}
                  disabled={isDeleting}
                  className="absolute top-4 right-4 text-red-600 hover:text-red-800 disabled:opacity-50"
                  title="Delete project"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        <ProjectCreateModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          onCreate={handleCreate}
          isLoading={isCreating}
        />
      </div>
    </Layout>
  );
}

