import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageContainerProps {
  children: ReactNode;
  /** Overrides the default reading width (`max-w-3xl`). */
  className?: string;
}

/** A scrolling, centred column for the non-browser pages. */
export function PageContainer({ children, className }: PageContainerProps) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className={cn('mx-auto w-full max-w-3xl p-4 sm:p-6', className)}>{children}</div>
    </div>
  );
}
