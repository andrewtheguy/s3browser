const DEFAULT_TTLS = '1h,1d';

const UNIT_TO_SECONDS = {
  h: 60 * 60,
  d: 60 * 60 * 24,
  w: 60 * 60 * 24 * 7,
} as const;

const UNIT_NAMES = {
  h: 'hour',
  d: 'day',
  w: 'week',
} as const;

type Unit = keyof typeof UNIT_TO_SECONDS;

export interface PresignedUrlTtlOption {
  ttl: number;
  shortLabel: string;
  longLabel: string;
}

function formatTtl(value: number, unit: Unit): string {
  const name = UNIT_NAMES[unit];
  return `${value} ${name}${value === 1 ? '' : 's'}`;
}

function parseEntry(entry: string): PresignedUrlTtlOption | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  // Exactly one positive integer + exactly one unit (h/d/w). No mixing like "1d2h".
  const match = /^(\d+)([hdw])$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1], 10);
  if (value <= 0) {
    return null;
  }
  const unit = match[2] as Unit;
  return {
    ttl: value * UNIT_TO_SECONDS[unit],
    shortLabel: `${value}${unit}`,
    longLabel: formatTtl(value, unit),
  };
}

function parseTtls(raw: string | undefined): PresignedUrlTtlOption[] {
  const source = raw?.trim() ? raw : DEFAULT_TTLS;
  const options: PresignedUrlTtlOption[] = [];
  for (const entry of source.split(',')) {
    const parsed = parseEntry(entry);
    if (parsed) {
      options.push(parsed);
    } else if (entry.trim()) {
      console.warn(`presignedUrls: ignoring invalid TTL entry "${entry.trim()}"`);
    }
  }
  return options.length > 0 ? options : parseTtls(DEFAULT_TTLS);
}

let cached: readonly PresignedUrlTtlOption[] | null = null;

export function getPresignedUrlTtlOptions(): readonly PresignedUrlTtlOption[] {
  if (!cached) {
    cached = Object.freeze(parseTtls(process.env.S3BROWSER_PRESIGNED_URL_TTLS));
  }
  return cached;
}
