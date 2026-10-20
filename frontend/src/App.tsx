import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { Toaster } from '@/components/ui/sonner';
import { SessionProvider } from './contexts/SessionContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { queryClient } from './queries/client';
import { router } from './router';

function ThemedToaster() {
  const { resolved } = useTheme();
  return <Toaster theme={resolved} />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SessionProvider>
          <RouterProvider router={router} />
          <ThemedToaster />
        </SessionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
