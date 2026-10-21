import { Navigate, Outlet, useLocation } from 'react-router';
import { useSession } from '../contexts/SessionContext';
import { buildLoginUrl } from '../utils/urlEncoding';
import { CenteredLoader } from './CenteredLoader';

/** Layout route: everything below it needs a signed-in session. */
export function RequireAuth() {
  const { isLoggedIn, isCheckingSession } = useSession();
  const location = useLocation();

  if (isCheckingSession) {
    return <CenteredLoader />;
  }
  if (!isLoggedIn) {
    return <Navigate to={buildLoginUrl(location.pathname + location.search)} replace />;
  }
  return <Outlet />;
}
