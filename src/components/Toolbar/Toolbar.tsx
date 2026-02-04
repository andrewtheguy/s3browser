import { useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Home,
  Upload,
  FolderPlus,
  RefreshCw,
  LogOut,
  Trash2,
  Download,
  ArrowLeftRight,
  Info,
  FlaskConical,
  History,
  MoreVertical,
  CheckSquare,
  X,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  onBatchDownload?: () => void;
  onBatchDelete?: () => void;
  isDeleting?: boolean;
  isDownloading?: boolean;
  selectionMode?: boolean;
  onToggleSelection?: () => void;
  showVersions?: boolean;
  onToggleVersions?: () => void;
  /** null = checking, true = supported, false = not supported/disabled */
  versioningSupported?: boolean | null;
  bucketVersioningStatus?: 'enabled' | 'suspended' | 'disabled' | null;
  onSeedTestItems?: () => void;
  isSeedingTestItems?: boolean;
}

export function Toolbar({
  onUploadClick,
  onCreateFolderClick,
  onBucketInfoClick,
  selectedCount = 0,
  onBatchDownload,
  onBatchDelete,
  isDeleting = false,
  isDownloading = false,
  selectionMode = false,
  onToggleSelection,
  showVersions = false,
  onToggleVersions,
  versioningSupported = null,
  bucketVersioningStatus = null,
  onSeedTestItems,
  isSeedingTestItems = false,
}: ToolbarProps) {
  const navigate = useNavigate();
  const { connectionId } = useParams<{ connectionId?: string }>();
  const { credentials, disconnect, activeConnectionId, activeProfileName } = useS3ClientContext();
  const { pathSegments, navigateTo, refresh, isLoading } = useBrowserContext();

  const versionsButtonLabel = useMemo(() => {
    if (bucketVersioningStatus === 'disabled') {
      return 'Versions Disabled';
    }
    if (versioningSupported === null) {
      return 'Versions...';
    }
    if (versioningSupported === false) {
      return 'Versions (not supported)';
    }
    return showVersions ? 'Hide Versions' : 'Show Versions';
  }, [bucketVersioningStatus, showVersions, versioningSupported]);

  const versionsButtonTooltip = useMemo(() => {
    if (bucketVersioningStatus === 'disabled') {
      return 'Bucket versioning is disabled';
    }
    if (versioningSupported === null) {
      return 'Checking versioning support...';
    }
    if (versioningSupported === false) {
      return 'Versioning not supported by this storage';
    }
    return showVersions ? 'Hide versions' : 'Show versions';
  }, [bucketVersioningStatus, showVersions, versioningSupported]);

  const handleDisconnect = useCallback(async () => {
    try {
      await disconnect();
    } catch (error) {
      console.error('Disconnect failed:', error);
    } finally {
      void navigate('/');
    }
  }, [disconnect, navigate]);

  const handleChooseConnection = useCallback(() => {
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
                  onClick={handleChooseConnection}
                >
                  <ArrowLeftRight className="h-4 w-4 mr-1" />
                  {activeProfileName ?? '—'}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Change connection profile</TooltipContent>
            </Tooltip>
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
            {selectionMode && selectedCount > 0 && onBatchDownload && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={onBatchDownload}
                    disabled={isDownloading}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isDownloading ? 'Downloading...' : `Download ${selectedCount} item(s)`}</TooltipContent>
              </Tooltip>
            )}

            {selectionMode && selectedCount > 0 && onBatchDelete && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="text-destructive border-destructive hover:bg-destructive/10"
                    onClick={onBatchDelete}
                    disabled={isDeleting}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isDeleting ? 'Deleting...' : `Delete ${selectedCount} item(s)`}</TooltipContent>
              </Tooltip>
            )}

            {/* More menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={refresh} disabled={isLoading}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                {onToggleSelection && (
                  <DropdownMenuItem onClick={onToggleSelection}>
                    {selectionMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
                    {selectionMode ? 'Cancel Selection' : 'Select'}
                  </DropdownMenuItem>
                )}

                <DropdownMenuItem onClick={onCreateFolderClick}>
                  <FolderPlus className="h-4 w-4" />
                  New Folder
                </DropdownMenuItem>

                <DropdownMenuItem onClick={onUploadClick}>
                  <Upload className="h-4 w-4" />
                  Upload
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuItem
                  onClick={onToggleVersions}
                  disabled={versioningSupported !== true}
                >
                  <History className="h-4 w-4" />
                  {versionsButtonLabel}
                </DropdownMenuItem>

                {seedButtonEnabled && onSeedTestItems && (
                  <DropdownMenuItem
                    onClick={onSeedTestItems}
                    disabled={isSeedingTestItems}
                  >
                    <FlaskConical className="h-4 w-4" />
                    {isSeedingTestItems ? 'Seeding...' : `Seed ${SEED_TEST_ITEM_COUNT}`}
                  </DropdownMenuItem>
                )}

                <DropdownMenuSeparator />

                <DropdownMenuItem
                  onClick={handleDisconnect}
                  className="text-destructive focus:text-destructive"
                >
                  <LogOut className="h-4 w-4" />
                  Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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

            {/* Show versions button:
                - versioningSupported === null: checking (disabled, "Versions...")
                - versioningSupported === true: supported (enabled, clickable)
                - versioningSupported === false: not supported (disabled, "not supported") */}
            {(onToggleVersions || versioningSupported !== true) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={showVersions ? 'default' : 'outline'}
                    onClick={onToggleVersions}
                    disabled={versioningSupported !== true}
                  >
                    {versionsButtonLabel}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {versionsButtonTooltip}
                </TooltipContent>
              </Tooltip>
            )}

            {selectionMode && selectedCount > 0 && onBatchDownload && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    onClick={onBatchDownload}
                    disabled={isDownloading}
                  >
                    <Download className="h-4 w-4 mr-2 sm:mr-1" />
                    <span className="hidden sm:inline">
                      {isDownloading ? 'Downloading...' : `Download (${selectedCount})`}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isDownloading ? 'Downloading...' : `Download ${selectedCount} item(s)`}</TooltipContent>
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
