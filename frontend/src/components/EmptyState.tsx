import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** Dashed panel with the icon in an orange-tinted circle. */
export function EmptyState({ icon, title, description, children, className }: EmptyStateProps) {
  return (
    <div className={cn('rounded-xl border border-dashed bg-card/50 px-6 py-12 text-center', className)}>
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/12 text-primary-ink [&_svg]:h-8 [&_svg]:w-8">
        {icon}
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {children && <div className="mt-5 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}
