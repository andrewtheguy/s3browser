import { Spinner } from '@/components/ui/spinner';

/** A spinner filling whatever flex column it is placed in. */
export function CenteredLoader({ label }: { label?: string }) {
  return (
    <div className="flex flex-1 min-h-[50vh] flex-col items-center justify-center gap-3">
      <Spinner size="lg" />
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
    </div>
  );
}
