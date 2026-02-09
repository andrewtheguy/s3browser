import { createBrowserRouter } from 'react-router';
import { RootLayout } from './layouts/RootLayout';
import { HomePage } from './pages/HomePage';
import { SelectBucketPage } from './pages/SelectBucketPage';
import { BrowsePage } from './pages/BrowsePage';
import { AuthGuard } from './components/AuthGuard';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: <HomePage />,
      },
      {
        path: 'connection/:connectionId/browse',
        element: (
          <AuthGuard>
            <SelectBucketPage />
          </AuthGuard>
        ),
      },
      {
        path: 'connection/:connectionId/browse/:bucket/*',
        element: (
          <AuthGuard>
            <BrowsePage />
          </AuthGuard>
        ),
      },
    ],
  },
]);
