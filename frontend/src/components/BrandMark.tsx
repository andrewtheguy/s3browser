import { cn } from '@/lib/utils';

/** The logo (the same file serves as the favicon). Decorative: pair it with visible text. */
export function BrandMark({ className }: { className?: string }) {
  return <img src="/favicon.svg" alt="" aria-hidden="true" className={cn('h-7 w-7 shrink-0', className)} />;
}

/**
 * "s3browser" with an orange "s3". Plain primary only reads on navy; on light
 * surfaces keep the default `text-primary-ink`.
 */
export function Wordmark({ className, accentClassName = 'text-primary-ink' }: { className?: string; accentClassName?: string }) {
  return (
    <span className={cn('font-semibold tracking-tight', className)}>
      <span className={accentClassName}>s3</span>browser
    </span>
  );
}
