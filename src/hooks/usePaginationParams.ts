import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

interface UsePaginationParamsOptions {
  PAGE_QUERY_PARAM: string;
  totalPages: number;
  isLoading: boolean;
}

export function usePaginationParams({
  PAGE_QUERY_PARAM,
  totalPages,
  isLoading,
}: UsePaginationParamsOptions) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const clampedPage = Math.min(page, totalPages);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const pageParam = searchParams.get(PAGE_QUERY_PARAM);
    const parsedPage = pageParam ? Number(pageParam) : NaN;
    const hasValidPageParam = Number.isFinite(parsedPage) && parsedPage >= 1;

    let nextPage = 1;
    if (totalPages > 1 && hasValidPageParam) {
      nextPage = Math.min(totalPages, Math.floor(parsedPage));
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync pagination with query params
    setPage((prev) => (prev === nextPage ? prev : nextPage));
  }, [isLoading, searchParams, totalPages, PAGE_QUERY_PARAM]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (totalPages <= 1) {
      if (searchParams.has(PAGE_QUERY_PARAM)) {
        const nextParams = new URLSearchParams(searchParams);
        nextParams.delete(PAGE_QUERY_PARAM);
        setSearchParams(nextParams, { replace: true });
      }
      return;
    }

    const pageValue = String(clampedPage);
    if (searchParams.get(PAGE_QUERY_PARAM) !== pageValue) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set(PAGE_QUERY_PARAM, pageValue);
      setSearchParams(nextParams, { replace: true });
    }
  }, [clampedPage, isLoading, searchParams, setSearchParams, totalPages, PAGE_QUERY_PARAM]);

  return [clampedPage, setPage] as const;
}
