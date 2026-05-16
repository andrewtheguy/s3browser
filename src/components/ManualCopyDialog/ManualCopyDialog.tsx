import { useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface ManualCopyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string | null;
  title: string;
}

export function ManualCopyDialog({ open, onOpenChange, url, title }: ManualCopyDialogProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }, 50);
    return () => window.clearTimeout(id);
  }, [open, url]);

  const handleRetryCopy = useCallback(async () => {
    if (!url) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        toast.success('Copied to clipboard');
        onOpenChange(false);
        return;
      } catch {
        // Fall through — leave the dialog open so the user can copy manually.
      }
    }
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, [url, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Automatic clipboard copy isn't available in this browser context. Select the text below and press Ctrl/Cmd+C to copy.
          </DialogDescription>
        </DialogHeader>
        <textarea
          ref={textareaRef}
          readOnly
          value={url ?? ''}
          rows={5}
          className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm font-mono break-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          onFocus={(e) => e.currentTarget.select()}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={handleRetryCopy}>Copy</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
