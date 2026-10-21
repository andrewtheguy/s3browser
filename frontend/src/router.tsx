import { createBrowserRouter } from 'react-router';
import { RedirectHome } from './components/RedirectHome';
import { RequireAuth } from './components/RequireAuth';
import { AppLayout } from './layouts/AppLayout';
import { ConnectionLayout } from './layouts/ConnectionLayout';
import { BrowsePage } from './pages/BrowsePage';
import { ConnectionFormPage } from './pages/ConnectionFormPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { LoginPage } from './pages/LoginPage';
import { SearchPage } from './pages/SearchPage';
import { SelectBucketPage } from './pages/SelectBucketPage';
import { LOGIN_URL } from './utils/urlEncoding';

export const router = createBrowserRouter([
  { path: LOGIN_URL, element: <LoginPage /> },
  {
    path: '/',
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <ConnectionsPage /> },
          { path: 'connection/new', element: <ConnectionFormPage /> },
          {
            path: 'connection/:connectionId',
            element: <ConnectionLayout />,
            children: [
              { index: true, element: <SelectBucketPage /> },
              { path: 'edit', element: <ConnectionFormPage /> },
              { path: 'browse/:bucket/*', element: <BrowsePage /> },
              { path: 'preview/:bucket/*', element: <BrowsePage /> },
              { path: 'search/:bucket', element: <SearchPage /> },
            ],
          },
          { path: '*', element: <RedirectHome reason="Page not found." /> },
        ],
      },
    ],
  },
]);
