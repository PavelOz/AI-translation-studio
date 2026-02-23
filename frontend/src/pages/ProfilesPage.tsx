import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import ProfileModal from '../components/ProfileModal';
import { profilesApi, type Profile } from '../api/profiles.api';

type ProfileFormData = {
  name: string;
  expertRole: string;
  instructions: string;
  terminologyJSON: string;
};

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadProfiles = async () => {
    setLoading(true);
    try {
      const list = await profilesApi.list();
      setProfiles(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfiles();
  }, []);

  const handleOpenCreate = () => {
    setEditingProfile(null);
    setModalOpen(true);
  };

  const handleOpenEdit = (profile: Profile) => {
    setEditingProfile(profile);
    setModalOpen(true);
  };

  const handleCloseModal = () => {
    setModalOpen(false);
    setEditingProfile(null);
  };

  const parseTerminology = (raw: string): unknown => {
    const s = raw.trim();
    if (!s) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };

  const handleSubmit = async (data: ProfileFormData) => {
    setSaving(true);
    try {
      const payload = {
        name: data.name.trim(),
        expertRole: data.expertRole.trim() || undefined,
        instructions: data.instructions.trim() || undefined,
        terminologyJSON: data.terminologyJSON.trim() ? parseTerminology(data.terminologyJSON) : null,
      };
      if (editingProfile) {
        await profilesApi.update(editingProfile.id, payload);
      } else {
        await profilesApi.create(payload);
      }
      await loadProfiles();
      handleCloseModal();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (profile: Profile) => {
    if (!window.confirm(`Delete profile "${profile.name}"? Documents using it will keep the profile reference until you change it.`)) return;
    setDeletingId(profile.id);
    try {
      await profilesApi.delete(profile.id);
      await loadProfiles();
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <Layout>
        <div className="text-center py-12">Loading profiles...</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold text-gray-900">Profiles</h1>
          <button onClick={handleOpenCreate} className="btn btn-primary">
            + New Profile
          </button>
        </div>

        <p className="text-gray-600">
          Profiles define expert role, instructions, and terminology for Document DNA and AI analysis. Leave fields empty to rely only on document context.
        </p>

        {profiles.length === 0 ? (
          <div className="card text-center py-12">
            <p className="text-gray-500 mb-4">No profiles yet</p>
            <button onClick={handleOpenCreate} className="btn btn-primary">
              Create first profile
            </button>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expert role</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Instructions</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {profiles.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{p.name}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate" title={p.expertRole || undefined}>
                      {p.expertRole || '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate" title={p.instructions || undefined}>
                      {p.instructions || '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm">
                      <button
                        onClick={() => handleOpenEdit(p)}
                        className="text-primary-600 hover:text-primary-800 font-medium mr-3"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(p)}
                        disabled={deletingId === p.id}
                        className="text-red-600 hover:text-red-800 font-medium disabled:opacity-50"
                      >
                        {deletingId === p.id ? 'Deleting...' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <ProfileModal
          isOpen={modalOpen}
          onClose={handleCloseModal}
          profile={editingProfile}
          onSubmit={handleSubmit}
          isLoading={saving}
        />
      </div>
    </Layout>
  );
}
