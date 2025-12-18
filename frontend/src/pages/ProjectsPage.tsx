import { useState } from 'react';
import Layout from '../components/Layout';
import { useProjects } from '../hooks/useProjects';
import { Link, useNavigate } from 'react-router-dom';
import ProjectCreateModal from '../components/ProjectCreateModal';
import type { CreateProjectRequest } from '../api/projects.api';

export default function ProjectsPage() {
  const { projects, isLoading, create, isCreating, delete: deleteProject, isDeleting } = useProjects();
  const navigate = useNavigate();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<string>('name_asc');

  const handleCreate = (data: CreateProjectRequest) => {
    create(data);
    setIsModalOpen(false);
  };

  const handleDelete = async (projectId: string, projectName: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (window.confirm(`Are you sure you want to delete project "${projectName}"? This action cannot be undone.`)) {
      deleteProject(projectId);
    }
  };

  // Filter projects based on search query, client, domain, and status
  const filteredProjects = projects.filter((project) => {
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesSearch = 
        project.name.toLowerCase().includes(query) ||
        project.description?.toLowerCase().includes(query) ||
        project.clientName?.toLowerCase().includes(query);
      if (!matchesSearch) return false;
    }

    // Client filter
    if (clientFilter && project.clientName?.toLowerCase() !== clientFilter.toLowerCase()) {
      return false;
    }

    // Domain filter
    if (domainFilter && project.domain?.toLowerCase() !== domainFilter.toLowerCase()) {
      return false;
    }

    // Status filter
    if (statusFilter !== 'ALL' && project.status !== statusFilter) {
      return false;
    }

    return true;
  });

  // Sort filtered projects
  const sortedProjects = [...filteredProjects].sort((a, b) => {
    switch (sortBy) {
      case 'name_asc':
        return (a.name || '').localeCompare(b.name || '');
      case 'name_desc':
        return (b.name || '').localeCompare(a.name || '');
      case 'created_asc':
        return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
      case 'created_desc':
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      case 'status_asc':
        return (a.status || '').localeCompare(b.status || '');
      case 'status_desc':
        return (b.status || '').localeCompare(a.status || '');
      case 'client_asc':
        return (a.clientName || '').localeCompare(b.clientName || '');
      case 'client_desc':
        return (b.clientName || '').localeCompare(a.clientName || '');
      case 'domain_asc':
        return (a.domain || '').localeCompare(b.domain || '');
      case 'domain_desc':
        return (b.domain || '').localeCompare(a.domain || '');
      default:
        return 0;
    }
  });

  // Get unique clients and domains for filter dropdowns
  const uniqueClients = Array.from(new Set(projects.map(p => p.clientName).filter(Boolean))).sort();
  const uniqueDomains = Array.from(new Set(projects.map(p => p.domain).filter(Boolean))).sort();

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

        {/* Filters and Sorting */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Filters & Sorting</h2>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Search</label>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input w-full"
                placeholder="Search projects..."
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Client</label>
              <select
                value={clientFilter}
                onChange={(e) => setClientFilter(e.target.value)}
                className="input w-full"
              >
                <option value="">All Clients</option>
                {uniqueClients.map((client) => (
                  <option key={client} value={client}>
                    {client}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Domain</label>
              <select
                value={domainFilter}
                onChange={(e) => setDomainFilter(e.target.value)}
                className="input w-full"
              >
                <option value="">All Domains</option>
                {uniqueDomains.map((domain) => (
                  <option key={domain} value={domain}>
                    {domain}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="input w-full"
              >
                <option value="ALL">All Statuses</option>
                <option value="NEW">New</option>
                <option value="IN_PROGRESS">In Progress</option>
                <option value="COMPLETED">Completed</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Sort By</label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="input w-full"
              >
                <option value="name_asc">Name (A-Z)</option>
                <option value="name_desc">Name (Z-A)</option>
                <option value="created_desc">Date Created (Newest)</option>
                <option value="created_asc">Date Created (Oldest)</option>
                <option value="status_asc">Status (A-Z)</option>
                <option value="status_desc">Status (Z-A)</option>
                <option value="client_asc">Client (A-Z)</option>
                <option value="client_desc">Client (Z-A)</option>
                <option value="domain_asc">Domain (A-Z)</option>
                <option value="domain_desc">Domain (Z-A)</option>
              </select>
            </div>
          </div>
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
        ) : filteredProjects.length === 0 ? (
          <div className="card text-center py-12">
            <p className="text-gray-500 mb-4">No projects match your filters</p>
            <button
              onClick={() => {
                setSearchQuery('');
                setClientFilter('');
                setDomainFilter('');
                setStatusFilter('ALL');
              }}
              className="btn btn-secondary"
            >
              Clear Filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {sortedProjects.map((project) => (
              <div
                key={project.id}
                className="card hover:shadow-lg transition-shadow relative"
              >
                <Link
                  to={`/projects/${project.id}`}
                  className="block"
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
                <button
                  onClick={(e) => handleDelete(project.id, project.name, e)}
                  disabled={isDeleting}
                  className="absolute top-2 right-2 text-red-600 hover:text-red-800 text-sm font-medium disabled:opacity-50"
                  title="Delete project"
                >
                  ×
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

