import { useContext } from 'react';
import type { S3ClientContextValue } from '../types';
import { S3ClientContext } from './S3ClientContext';

export function useS3ClientContext(): S3ClientContextValue {
  const context = useContext(S3ClientContext);
  if (!context) {
    throw new Error('useS3ClientContext must be used within a S3ClientProvider');
  }
  return context;
}
