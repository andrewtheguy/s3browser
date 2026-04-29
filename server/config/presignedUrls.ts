const DEFAULT_TTLS = '1h,1d';

// AWS S3 SigV4 caps presigned URL expiry at 7 days.
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

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

function parseEntry(entry: string): { option: PresignedUrlTtlOption } | { error: string } | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  // Exactly one positive integer + exactly one unit (h/d/w). No mixing like "1d2h".
  const match = /^(\d+)([hdw])$/.exec(trimmed);
  if (!match) {
    return { error: `invalid TTL entry "${trimmed}"` };
  }
  const value = Number.parseInt(match[1], 10);
  if (value <= 0) {
    return { error: `invalid TTL entry "${trimmed}"` };
  }
  const unit = match[2] as Unit;
  const ttl = value * UNIT_TO_SECONDS[unit];
  if (ttl > MAX_TTL_SECONDS) {
    return { error: `TTL "${trimmed}" exceeds AWS SigV4 maximum of 7 days` };
  }
  return {
    option: {
      ttl,
      shortLabel: `${value}${unit}`,
      longLabel: formatTtl(value, unit),
    },
  };
}

interface ParsedTtls {
  options: PresignedUrlTtlOption[];
  duplicates: string[];
}

function parseRawTtls(source: string): ParsedTtls {
  const options: PresignedUrlTtlOption[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const entry of source.split(',')) {
    const parsed = parseEntry(entry);
    if (!parsed) {
      continue;
    }
    if ('error' in parsed) {
      console.warn(`presignedUrls: ignoring ${parsed.error}`);
      continue;
    }
    const { option } = parsed;
    if (seen.has(option.shortLabel)) {
      duplicates.push(option.shortLabel);
      continue;
    }
    seen.add(option.shortLabel);
    options.push(option);
  }
  return { options, duplicates };
}

function parseTtls(raw: string | undefined): PresignedUrlTtlOption[] {
  const source = raw?.trim() || DEFAULT_TTLS;
  const { options, duplicates } = parseRawTtls(source);
  if (duplicates.length > 0) {
    const unique = Array.from(new Set(duplicates));
    throw new Error(
      `S3BROWSER_PRESIGNED_URL_TTLS contains duplicate entr${unique.length === 1 ? 'y' : 'ies'}: ${unique.join(', ')}`,
    );
  }
  if (options.length > 0) {
    return options;
  }
  return parseRawTtls(DEFAULT_TTLS).options;
}

let cached: readonly PresignedUrlTtlOption[] | null = null;

export function getPresignedUrlTtlOptions(): readonly PresignedUrlTtlOption[] {
  if (!cached) {
    cached = Object.freeze(parseTtls(process.env.S3BROWSER_PRESIGNED_URL_TTLS));
  }
  return cached;
}
