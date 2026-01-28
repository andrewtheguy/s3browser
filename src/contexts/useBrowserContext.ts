import { useContext } from 'react';
import type { BrowserContextValue } from '../types';
import { BrowserContext } from './BrowserContext';

export function useBrowserContext(): BrowserContextValue {
  const context = useContext(BrowserContext);
  if (!context) {
    throw new Error('useBrowserContext must be used within a BrowserProvider');
  }
  return context;
}
