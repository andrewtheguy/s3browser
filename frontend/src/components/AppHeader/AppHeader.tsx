import { ChevronRight, LogOut, Monitor, Moon, Settings, Sun } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { BrandMark, Wordmark } from '@/components/BrandMark';
import { BucketIcon, CloudBucketIcon, EndpointIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSession } from '../../contexts/SessionContext';
import { useTheme, type ThemePreference } from '../../contexts/ThemeContext';
import { useConnectionQuery } from '../../queries/connections';
import {
  CONNECTIONS_URL,
  LOGIN_URL,
  buildBrowseUrl,
  buildSelectBucketUrl,
  parseConnectionId,
} from '../../utils/urlEncoding';

const crumbClass =
  'flex h-9 min-w-0 max-w-[9rem] items-center gap-1.5 rounded-md px-2 text-sm text-brand-muted transition-colors hover:bg-white/10 hover:text-brand-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:max-w-xs';
const currentCrumbClass = 'font-medium text-brand-foreground';

export function AppHeader() {
  const params = useParams<{ connectionId?: string; bucket?: string }>();
  const connectionId = parseConnectionId(params.connectionId);
  const bucket = params.bucket;
  const { data: connection } = useConnectionQuery(connectionId);
  const { preference, setPreference } = useTheme();
  const { logout } = useSession();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await logout();
    void navigate(LOGIN_URL, { replace: true });
  };

  return (
    <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-1 border-b-2 border-primary bg-linear-to-r from-brand to-brand-2 px-2 text-brand-foreground sm:px-4">
      <nav aria-label="Location" className="flex min-w-0 flex-1 items-center gap-0.5">
        <Link
          to={CONNECTIONS_URL}
          className="flex h-10 shrink-0 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label="s3browser"
        >
          <BrandMark />
          <Wordmark className={cn(connectionId !== null && 'hidden sm:inline')} accentClassName="text-primary" />
        </Link>
        {connectionId !== null && (
          <>
            <ChevronRight className="h-4 w-4 shrink-0 text-brand-muted/60" aria-hidden="true" />
            <Link
              to={buildSelectBucketUrl(connectionId)}
              className={cn(crumbClass, !bucket && currentCrumbClass)}
              title={connection?.profileName}
            >
              {connection && !connection.endpoint ? (
                <CloudBucketIcon className="h-4 w-4" />
              ) : (
                <EndpointIcon className="h-4 w-4" />
              )}
              <span className="truncate">{connection?.profileName ?? '…'}</span>
            </Link>
          </>
        )}
        {connectionId !== null && bucket && (
          <>
            <ChevronRight className="h-4 w-4 shrink-0 text-brand-muted/60" aria-hidden="true" />
            <Link to={buildBrowseUrl(connectionId, bucket, '')} className={cn(crumbClass, currentCrumbClass)} title={bucket}>
              <BucketIcon className="h-4 w-4" />
              <span className="truncate">{bucket}</span>
            </Link>
          </>
        )}
      </nav>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 shrink-0 text-brand-foreground hover:bg-white/10 hover:text-brand-foreground focus-visible:ring-primary focus-visible:ring-offset-brand"
            aria-label="Settings"
          >
            <Settings className="h-5 w-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={preference}
            onValueChange={(value) => setPreference(value as ThemePreference)}
          >
            <DropdownMenuRadioItem value="system">
              <Monitor className="mr-2 h-4 w-4" />
              System
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">
              <Sun className="mr-2 h-4 w-4" />
              Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <Moon className="mr-2 h-4 w-4" />
              Dark
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => void handleSignOut()}
            className="text-destructive focus:text-destructive"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
