import { useBrowserContext } from '../contexts';

export function useListObjects() {
  const { objects, isLoading, error, refresh } = useBrowserContext();

  return {
    objects,
    isLoading,
    error,
    refresh,
  };
}
