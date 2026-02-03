import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Home,
  Upload,
  FolderPlus,
  RefreshCw,
  LogOut,
  Trash2,
  Settings,
  Info,
  FlaskConical,
} from 'lucide-react';
import { BucketIcon } from '@/components/ui/bucket-icon';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { useBrowserContext, useS3ClientContext } from '../../contexts';
import { buildSelectBucketUrl } from '../../utils/urlEncoding';

const SEED_TEST_ITEM_COUNT = 10005;
const seedEnv = import.meta.env as { MODE?: string; VITE_FEATURE_SEED_TEST_ITEMS?: string };
const seedFeatureEnabled = seedEnv.VITE_FEATURE_SEED_TEST_ITEMS === 'true'
  || seedEnv.VITE_FEATURE_SEED_TEST_ITEMS === '1';
const seedButtonEnabled = seedEnv.MODE !== 'production' || seedFeatureEnabled;

interface ToolbarProps {
  onUploadClick: () => void;
  onCreateFolderClick: () => void;
  onBucketInfoClick: () => void;
  selectedCount?: number;
  onBatchDelete?: () => void;
  isDeleting?: boolean;
  selectionMode?: boolean;
  onToggleSelection?: () => void;
  onSeedTestItems?: () => void;
  isSeedingTestItems?: boolean;
}

export function Toolbar({
  onUploadClick,
  onCreateFolderClick,
  onBucketInfoClick,
  selectedCount = 0,
  onBatchDelete,
  isDeleting = false,
  selectionMode = false,
  onToggleSelection,
  onSeedTestItems,
  isSeedingTestItems = false,
}: ToolbarProps) {
  const navigate = useNavigate();
  const { connectionId } = useParams<{ connectionId?: string }>();
  const { credentials, disconnect, activeConnectionId } = useS3ClientContext();
  const { pathSegments, navigateTo, refresh, isLoading } = useBrowserContext();

  const handleDisconnect = useCallback(async () => {
    try {
      await disconnect();
    } catch (error) {
      console.error('Disconnect failed:', error);
    } finally {
      void navigate('/');
    }
  }, [disconnect, navigate]);

  const handleManageConnections = useCallback(() => {
    void navigate('/');
  }, [navigate]);

  const handleChangeBucket = useCallback(() => {
    const parsedId = connectionId ? parseInt(connectionId, 10) : NaN;
    const connId = !isNaN(parsedId) && parsedId > 0 ? parsedId : activeConnectionId;

    if (!connId || connId <= 0) {
      console.error('Cannot change bucket: no valid connection ID available');
      void navigate('/');
      return;
    }

    void navigate(buildSelectBucketUrl(connId));
  }, [connectionId, activeConnectionId, navigate]);

  const handleBreadcrumbClick = (index: number) => {
    if (index === -1) {
      navigateTo('');
    } else {
      const path = pathSegments.slice(0, index + 1).join('/') + '/';
      navigateTo(path);
    }
  };

  return (
    <TooltipProvider>
      <div className="p-4 border-b">
        <div className="flex items-center justify-between mb-2 sm:mb-4">
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleChangeBucket}
                >
                  <BucketIcon className="h-4 w-4 mr-1" />
                  {credentials?.bucket ?? '—'}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Click to change bucket</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBucketInfoClick}>
                  <Info className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Bucket settings</TooltipContent>
            </Tooltip>
          </div>

          {/* Mobile actions */}
          <div className="flex sm:hidden gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={refresh} disabled={isLoading}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>
            {seedButtonEnabled && onSeedTestItems && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={onSeedTestItems}
                    disabled={isSeedingTestItems}
                  >
                    <FlaskConical className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Seed {SEED_TEST_ITEM_COUNT} test items</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" onClick={handleManageConnections}>
                  <Settings className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Choose Connection</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleDisconnect} className="text-destructive hover:text-destructive">
                  <LogOut className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Sign Out</TooltipContent>
            </Tooltip>
          </div>

          {/* Desktop actions */}
          <div className="hidden sm:flex gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={refresh} disabled={isLoading}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>

            {onToggleSelection && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={selectionMode ? 'default' : 'outline'}
                    onClick={onToggleSelection}
                  >
                    {selectionMode ? 'Cancel' : 'Select'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{selectionMode ? 'Cancel selection' : 'Select items'}</TooltipContent>
              </Tooltip>
            )}

            {selectionMode && selectedCount > 0 && onBatchDelete && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    className="text-destructive border-destructive hover:bg-destructive/10"
                    onClick={onBatchDelete}
                    disabled={isDeleting}
                  >
                    <Trash2 className="h-4 w-4 mr-2 sm:mr-1" />
                    <span className="hidden sm:inline">
                      {isDeleting ? 'Deleting...' : `Delete (${selectedCount})`}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isDeleting ? 'Deleting...' : `Delete ${selectedCount} item(s)`}</TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" onClick={onCreateFolderClick}>
                  <FolderPlus className="h-4 w-4 mr-2 sm:mr-1" />
                  <span className="hidden sm:inline">New Folder</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>New Folder</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button onClick={onUploadClick}>
                  <Upload className="h-4 w-4 mr-2 sm:mr-1" />
                  <span className="hidden sm:inline">Upload</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Upload</TooltipContent>
            </Tooltip>

            {seedButtonEnabled && onSeedTestItems && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" onClick={onSeedTestItems} disabled={isSeedingTestItems}>
                    <FlaskConical className="h-4 w-4 mr-2 sm:mr-1" />
                    <span className="hidden sm:inline">
                      {isSeedingTestItems ? 'Seeding...' : `Seed ${SEED_TEST_ITEM_COUNT}`}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Seed {SEED_TEST_ITEM_COUNT} test items</TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" onClick={handleManageConnections}>
                  <Settings className="h-4 w-4 mr-2 sm:mr-1" />
                  <span className="hidden sm:inline">Choose Connection</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Choose Connection</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleDisconnect} className="text-destructive hover:text-destructive">
                  <LogOut className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Sign Out</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              {pathSegments.length === 0 ? (
                <BreadcrumbPage className="flex items-center">
                  <Home className="h-4 w-4 mr-1" />
                  Home
                </BreadcrumbPage>
              ) : (
                <BreadcrumbLink
                  className="flex items-center cursor-pointer"
                  onClick={() => handleBreadcrumbClick(-1)}
                >
                  <Home className="h-4 w-4 mr-1" />
                  Home
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>

            {pathSegments.map((segment, index) => {
              const isLast = index === pathSegments.length - 1;

              return (
                <BreadcrumbItem key={index}>
                  <BreadcrumbSeparator />
                  {isLast ? (
                    <BreadcrumbPage className="font-medium">
                      {segment}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      className="cursor-pointer"
                      onClick={() => handleBreadcrumbClick(index)}
                    >
                      {segment}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </TooltipProvider>
  );
}
