import { useState } from 'react';
import { ChevronRight, Cloud, Download, MoreVertical, Pencil, Pin, Server, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { BucketIcon } from '@/components/ui/bucket-icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { exportConnectionProfile, type ServerSavedConnection } from '../../services/api/auth';
import { downloadTextFile } from '../../utils/download';
import { formatRelativeTime } from '../../utils/relativeTime';
import { buildBrowseUrl, buildConnectionEditUrl, buildSelectBucketUrl } from '../../utils/urlEncoding';
import { DeleteConnectionDialog } from './DeleteConnectionDialog';

const MAX_RECENT_CHIPS = 4;

/** "AWS · us-east-1" for the default endpoint, otherwise the endpoint host. */
export function describeEndpoint(connection: Pick<ServerSavedConnection, 'endpoint' | 'region'>): string {
  if (!connection.endpoint) {
    return connection.region ? `AWS · ${connection.region}` : 'AWS';
  }
  try {
    return new URL(connection.endpoint).host;
  } catch {
    return connection.endpoint;
  }
}

/** Where "Open" lands: the default bucket when there is one, otherwise the bucket page. */
export function connectionOpenUrl(connection: ServerSavedConnection): string {
  return connection.bucket
    ? buildBrowseUrl(connection.id, connection.bucket, '')
    : buildSelectBucketUrl(connection.id);
}

function BucketChip({ to, children, pinned = false }: { to: string; children: string; pinned?: boolean }) {
  return (
    <Link
      to={to}
      className={cn(
        'inline-flex h-9 max-w-full items-center gap-1.5 rounded-full border px-3 text-sm hover:bg-accent hover:text-accent-foreground',
        pinned && 'border-primary/40 bg-primary/5',
      )}
      title={children}
    >
      {pinned ? <Pin className="h-3.5 w-3.5 shrink-0" /> : <BucketIcon className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">{children}</span>
    </Link>
  );
}

export function ConnectionCard({ connection }: { connection: ServerSavedConnection }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exporting, setExporting] = useState<null | 'aws' | 'rclone'>(null);

  const recents = connection.recentBuckets.filter((r) => r.name !== connection.bucket);
  const shownRecents = recents.slice(0, MAX_RECENT_CHIPS);
  const hiddenCount = recents.length - shownRecents.length;
  const hasChips = Boolean(connection.bucket) || shownRecents.length > 0;

  const handleExport = async (format: 'aws' | 'rclone') => {
    setExporting(format);
    try {
      const response = await exportConnectionProfile(connection.id, format, connection.bucket ?? undefined);
      downloadTextFile(response.filename, response.content);
      toast.success(`${format === 'aws' ? 'AWS' : 'rclone'} profile exported`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to export profile');
    } finally {
      setExporting(null);
    }
  };

  return (
    <li className="rounded-lg border bg-card text-card-foreground shadow-sm">
      <div className="flex items-stretch">
        <Link
          to={connectionOpenUrl(connection)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-l-lg px-4 py-3 hover:bg-accent/60"
        >
          {connection.endpoint ? (
            <Server className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <Cloud className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{connection.profileName}</div>
            <div className="truncate text-xs text-muted-foreground">
              {describeEndpoint(connection)} · Last used {formatRelativeTime(connection.lastUsedAt)}
            </div>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="mr-1 h-11 w-11 shrink-0 self-center"
              aria-label={`Actions for ${connection.profileName}`}
              disabled={exporting !== null}
            >
              <MoreVertical className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem asChild>
              <Link to={buildConnectionEditUrl(connection.id)}>
                <Pencil className="h-4 w-4" />
                Edit
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handleExport('aws')}>
              <Download className="h-4 w-4" />
              Export AWS config
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handleExport('rclone')}>
              <Download className="h-4 w-4" />
              Export rclone config
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setDeleteOpen(true)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {hasChips && (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          {connection.bucket && (
            <BucketChip to={buildBrowseUrl(connection.id, connection.bucket, '')} pinned>
              {connection.bucket}
            </BucketChip>
          )}
          {shownRecents.map((recent) => (
            <BucketChip key={recent.name} to={buildBrowseUrl(connection.id, recent.name, '')}>
              {recent.name}
            </BucketChip>
          ))}
          {hiddenCount > 0 && (
            <Link
              to={buildSelectBucketUrl(connection.id)}
              className="inline-flex h-9 items-center rounded-full px-3 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              +{hiddenCount} more
            </Link>
          )}
        </div>
      )}

      <DeleteConnectionDialog connection={connection} open={deleteOpen} onOpenChange={setDeleteOpen} />
    </li>
  );
}
