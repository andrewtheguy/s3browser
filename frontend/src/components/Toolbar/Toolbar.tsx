import { Fragment, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  Upload,
  FolderPlus,
  RefreshCw,
  Trash2,
  Download,
  Info,
  FlaskConical,
  History,
  MoreVertical,
  Search,
} from 'lucide-react';
import { BucketIcon } from '@/components/icons';
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
import { useBrowserContext } from '../../contexts';
import { useBucketRoute } from '../../hooks/useBucketRoute';
import { useConnectionQuery } from '../../queries/connections';
import { buildSearchUrl } from '../../utils/urlEncoding';

const currentCrumbClass =
  'font-semibold text-foreground underline decoration-primary decoration-2 underline-offset-[5px]';

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
  /** When set, the breadcrumb appends this as a non-clickable leaf so all folder segments stay clickable in preview mode. */
  previewFileName?: string | null;
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
  previewFileName = null,
}: ToolbarProps) {
  const navigate = useNavigate();
  const { connectionId, bucket } = useBucketRoute();
  const { data: connection } = useConnectionQuery(connectionId);
  const activeSearchEnabled = connection?.searchEnabled ?? false;
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

  const handleSearch = useCallback(() => {
    const currentPrefix = pathSegments.length > 0 ? pathSegments.join('/') + '/' : '';
    void navigate(buildSearchUrl(connectionId, bucket, currentPrefix));
  }, [connectionId, bucket, navigate, pathSegments]);

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
      <div className="border-b p-3 sm:p-4">
        <div className="flex items-center gap-2 sm:justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 shrink-0 sm:h-9 sm:w-9"
                  onClick={onBucketInfoClick}
                  aria-label="Bucket settings"
                >
                  <Info className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Bucket settings</TooltipContent>
            </Tooltip>
            <div className="min-w-0 flex-1 overflow-x-auto rounded-lg border bg-muted/40 px-2.5 py-1.5 [scrollbar-width:thin]">
              <Breadcrumb>
                <BreadcrumbList className="flex-nowrap">
                  <BreadcrumbItem>
                    {pathSegments.length === 0 && !previewFileName ? (
                      <BreadcrumbPage className={`flex items-center ${currentCrumbClass}`} title={`${bucket} root`}>
                        <BucketIcon className="h-4 w-4" />
                        <span className="ml-1.5 whitespace-nowrap">{bucket}</span>
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        className="flex cursor-pointer items-center hover:text-primary-ink"
                        onClick={() => handleBreadcrumbClick(-1)}
                        title={`${bucket} root`}
                      >
                        <BucketIcon className="h-4 w-4" />
                        <span className="ml-1.5 whitespace-nowrap">{bucket}</span>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>

                  {pathSegments.map((segment, index) => {
                    // In preview mode the file name is the leaf, so every folder segment is clickable.
                    const isLast = index === pathSegments.length - 1 && !previewFileName;

                    return (
                      <Fragment key={index}>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem className="whitespace-nowrap">
                          {isLast ? (
                            <BreadcrumbPage className={currentCrumbClass}>{segment}</BreadcrumbPage>
                          ) : (
                            <BreadcrumbLink className="cursor-pointer" onClick={() => handleBreadcrumbClick(index)}>
                              {segment}
                            </BreadcrumbLink>
                          )}
                        </BreadcrumbItem>
                      </Fragment>
                    );
                  })}

                  {previewFileName && (
                    <>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem className="whitespace-nowrap">
                        <BreadcrumbPage className={currentCrumbClass}>{previewFileName}</BreadcrumbPage>
                      </BreadcrumbItem>
                    </>
                  )}
                </BreadcrumbList>
              </Breadcrumb>
            </div>
          </div>

          {/* Mobile actions */}
          <div className="flex shrink-0 gap-1 sm:hidden">
            {selectionMode && selectedCount > 0 && onBatchDownload && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-11 w-11"
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
                    className="h-11 w-11 border-destructive text-destructive hover:bg-destructive/10"
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
                <Button variant="ghost" size="icon" className="h-11 w-11">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={refresh} disabled={isLoading}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </DropdownMenuItem>

                <DropdownMenuItem onClick={handleSearch} disabled={!activeSearchEnabled}>
                  <Search className="h-4 w-4" />
                  Search
                </DropdownMenuItem>

                <DropdownMenuSeparator />

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

              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Desktop actions */}
          <div className="hidden shrink-0 gap-2 sm:flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={refresh} disabled={isLoading} aria-label="Refresh">
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={activeSearchEnabled ? undefined : 0}>
                  <Button variant="outline" onClick={handleSearch} disabled={!activeSearchEnabled}>
                    <Search className="h-4 w-4 mr-2 sm:mr-1" />
                    <span className="hidden sm:inline">Search</span>
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {activeSearchEnabled
                  ? 'Search indexed keys in this bucket'
                  : "Search disabled: this connection's endpoint host is not in S3BROWSER_SEARCH_WHITELIST_HOSTS"}
              </TooltipContent>
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

          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
