import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ProjectsPage from './pages/ProjectsPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import DocumentViewPage from './pages/DocumentViewPage';
import EditorPage from './pages/EditorPage';
import ProjectReportPage from './pages/ProjectReportPage';
import UserReportPage from './pages/UserReportPage';
import ReportsPage from './pages/ReportsPage';
import TranslationMemoryPage from './pages/TranslationMemoryPage';
import GlossaryPage from './pages/GlossaryPage';
import ClusteringPage from './pages/ClusteringPage';

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <DashboardPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/projects"
        element={
          <PrivateRoute>
            <ProjectsPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/projects/:projectId"
        element={
          <PrivateRoute>
            <ProjectDetailPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/projects/:projectId/clusters"
        element={
          <PrivateRoute>
            <ClusteringPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/documents/:documentId"
        element={
          <PrivateRoute>
            <DocumentViewPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/documents/:documentId/editor"
        element={
          <PrivateRoute>
            <EditorPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/reports"
        element={
          <PrivateRoute>
            <ReportsPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/reports/projects/:projectId"
        element={
          <PrivateRoute>
            <ProjectReportPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/reports/users/:userId"
        element={
          <PrivateRoute>
            <UserReportPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/translation-memory"
        element={
          <PrivateRoute>
            <TranslationMemoryPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/glossary"
        element={
          <PrivateRoute>
            <GlossaryPage />
          </PrivateRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;

