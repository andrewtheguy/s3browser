/** "just now", "5m ago", "3h ago", "2d ago"; older dates fall back to a short date. */
export function formatRelativeTime(timestampMs: number | null | undefined, now: number = Date.now()): string {
  if (timestampMs === null || timestampMs === undefined || Number.isNaN(timestampMs)) return 'never';
  const elapsedSec = Math.max(0, Math.floor((now - timestampMs) / 1000));
  if (elapsedSec < 60) return 'just now';
  if (elapsedSec < 3600) return `${Math.floor(elapsedSec / 60)}m ago`;
  if (elapsedSec < 86_400) return `${Math.floor(elapsedSec / 3600)}h ago`;
  if (elapsedSec < 30 * 86_400) return `${Math.floor(elapsedSec / 86_400)}d ago`;
  return new Date(timestampMs).toLocaleDateString();
}
