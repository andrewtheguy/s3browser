import type { MouseEvent } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Spinner } from '@/components/ui/spinner';
import { useDeleteConnectionMutation } from '../../queries/connections';
import type { ServerSavedConnection } from '../../services/api/auth';

interface DeleteConnectionDialogProps {
  connection: ServerSavedConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}

export function DeleteConnectionDialog({ connection, open, onOpenChange, onDeleted }: DeleteConnectionDialogProps) {
  const mutation = useDeleteConnectionMutation();

  const handleConfirm = async (event: MouseEvent) => {
    event.preventDefault();
    try {
      await mutation.mutateAsync(connection.id);
      toast.success(`Deleted "${connection.profileName}"`);
      onOpenChange(false);
      onDeleted?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete connection');
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{connection.profileName}"?</AlertDialogTitle>
          <AlertDialogDescription>
            The saved credentials and recent buckets for this connection are removed. Nothing in S3 is touched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => void handleConfirm(event)}
            disabled={mutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {mutation.isPending ? <Spinner size="sm" className="text-destructive-foreground" /> : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
