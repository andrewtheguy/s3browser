import { Outlet } from 'react-router';
import { AppHeader } from '../components/AppHeader';

/** The shared shell: header on top, the page filling the rest of the viewport. */
export function AppLayout() {
  return (
    <div className="flex h-dvh flex-col bg-background">
      <AppHeader />
      <main className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
