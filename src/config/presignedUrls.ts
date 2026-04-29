import { useSyncExternalStore } from 'react';

export interface PresignedUrlTtlOption {
  ttl: number;
  shortLabel: string;
  longLabel: string;
}

const DEFAULT_OPTIONS: readonly PresignedUrlTtlOption[] = Object.freeze([
  Object.freeze({ ttl: 3600, shortLabel: '1h', longLabel: '1 hour' }),
  Object.freeze({ ttl: 86400, shortLabel: '1d', longLabel: '1 day' }),
]);

let currentOptions: readonly PresignedUrlTtlOption[] = DEFAULT_OPTIONS;
const listeners = new Set<() => void>();

function isValidOption(value: unknown): value is PresignedUrlTtlOption {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ttl === 'number' &&
    candidate.ttl > 0 &&
    typeof candidate.shortLabel === 'string' &&
    typeof candidate.longLabel === 'string'
  );
}

export function setPresignedUrlTtlOptions(options: readonly unknown[]): void {
  const filtered = options.filter(isValidOption);
  if (filtered.length === 0) {
    return;
  }
  currentOptions = Object.freeze(filtered.map((opt) => Object.freeze({ ...opt })));
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly PresignedUrlTtlOption[] {
  return currentOptions;
}

export function usePresignedUrlTtlOptions(): readonly PresignedUrlTtlOption[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
