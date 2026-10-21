import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { CONNECTIONS_URL } from '../utils/urlEncoding';
import { CenteredLoader } from './CenteredLoader';

/** Leave a dead end with an explanation instead of silently landing on the connections page. */
export function RedirectHome({ reason }: { reason: string }) {
  const navigate = useNavigate();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    toast.error(reason);
    void navigate(CONNECTIONS_URL, { replace: true });
  }, [navigate, reason]);

  return <CenteredLoader />;
}
