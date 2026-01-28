import { apiPost, apiGet } from './client';
import type { BucketInfo } from '../../types';

export interface LoginCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  bucket?: string;  // Optional - can be selected after login
  endpoint?: string;
}

export interface LoginResponse {
  success: boolean;
  region: string;
  bucket: string | null;
  endpoint?: string;
  requiresBucketSelection: boolean;
}

export interface AuthStatus {
  authenticated: boolean;
  region?: string;
  bucket?: string | null;
  endpoint?: string;
  requiresBucketSelection?: boolean;
}

export interface BucketsResponse {
  buckets: BucketInfo[];
}

export interface SelectBucketResponse {
  success: boolean;
  bucket: string;
}

export async function login(credentials: LoginCredentials): Promise<LoginResponse> {
  const response = await apiPost<LoginResponse>('/auth/login', credentials);
  if (!response) {
    throw new Error('Login failed: empty response');
  }
  return response;
}

export async function logout(): Promise<void> {
  await apiPost('/auth/logout');
}

export async function getAuthStatus(signal?: AbortSignal): Promise<AuthStatus> {
  const response = await apiGet<AuthStatus>('/auth/status', signal);
  if (!response) {
    throw new Error('Failed to get auth status: empty response');
  }
  return response;
}

export async function listBuckets(): Promise<BucketInfo[]> {
  const response = await apiGet<BucketsResponse>('/auth/buckets');
  if (!response) {
    throw new Error('Failed to list buckets: empty response');
  }
  return response.buckets;
}

export async function selectBucket(bucket: string): Promise<SelectBucketResponse> {
  const response = await apiPost<SelectBucketResponse>('/auth/select-bucket', { bucket });
  if (!response) {
    throw new Error('Failed to select bucket: empty response');
  }
  return response;
}
