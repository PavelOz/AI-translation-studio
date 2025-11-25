import { useState } from 'react';
import Layout from '../components/Layout';
import { useProjects } from '../hooks/useProjects';
import { Link } from 'react-router-dom';
import ProjectCreateModal from '../components/ProjectCreateModal';
import type { CreateProjectRequest } from '../api/projects.api';

export default function ProjectsPage() {
  const { projects, isLoading, create, isCreating } = useProjects();
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleCreate = (data: CreateProjectRequest) => {
    create(data);
    setIsModalOpen(false);
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
              <Link
                key={project.id}
                to={`/projects/${project.id}`}
                className="card hover:shadow-lg transition-shadow"
              >
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{project.name}</h3>
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

