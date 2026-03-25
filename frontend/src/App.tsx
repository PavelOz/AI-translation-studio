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
import ProfilesPage from './pages/ProfilesPage';
import StageMonitoringDashboard from './components/StageMonitoringDashboard';
import QualityControlPage from './pages/QualityControlPage';
import AdminQualityControlPage from './pages/AdminQualityControlPage';
import BillingSettingsPage from './pages/BillingSettingsPage';
import JanitorReviewScreen from './components/JanitorReviewScreen';

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
        path="/documents/:documentId/monitoring"
        element={
          <PrivateRoute>
            <StageMonitoringDashboard />
          </PrivateRoute>
        }
      />
      <Route
        path="/documents/:documentId/quality-control"
        element={
          <PrivateRoute>
            <QualityControlPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/documents/:documentId/janitor"
        element={
          <PrivateRoute>
            <JanitorReviewScreen />
          </PrivateRoute>
        }
      />
      <Route
        path="/admin/quality-control"
        element={
          <PrivateRoute>
            <AdminQualityControlPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/admin/billing"
        element={
          <PrivateRoute>
            <BillingSettingsPage />
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
      <Route
        path="/profiles"
        element={
          <PrivateRoute>
            <ProfilesPage />
          </PrivateRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;

