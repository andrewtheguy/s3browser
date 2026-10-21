import { ChevronRight, Cloud, LogOut, Monitor, Moon, Server, Settings, Sun } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { BucketIcon } from '@/components/ui/bucket-icon';
import { Button } from '@/components/ui/button';
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
  'flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-sm hover:bg-accent hover:text-accent-foreground max-w-[9rem] sm:max-w-xs';

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
    <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-1 border-b bg-background/95 px-2 backdrop-blur sm:px-4">
      <nav aria-label="Location" className="flex min-w-0 flex-1 items-center gap-0.5">
        <Link
          to={CONNECTIONS_URL}
          className="flex h-10 shrink-0 items-center gap-2 rounded px-1.5 font-semibold hover:bg-accent"
        >
          <Cloud className="h-5 w-5 text-primary" />
          <span className="hidden sm:inline">s3browser</span>
        </Link>
        {connectionId !== null && (
          <>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Link to={buildSelectBucketUrl(connectionId)} className={crumbClass} title={connection?.profileName}>
              <Server className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{connection?.profileName ?? '…'}</span>
            </Link>
          </>
        )}
        {connectionId !== null && bucket && (
          <>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Link to={buildBrowseUrl(connectionId, bucket, '')} className={crumbClass} title={bucket}>
              <BucketIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{bucket}</span>
            </Link>
          </>
        )}
      </nav>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0" aria-label="Settings">
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
