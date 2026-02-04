import { apiPost, apiGet, apiDelete } from './client';
import type { BucketInfo } from '../../types';

export interface LoginCredentials {
  password: string;
}

export interface LoginResponse {
  success: boolean;
}

export interface S3ConnectionCredentials {
  connectionId?: number;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  bucket?: string;
  endpoint?: string;
  profileName: string;
  autoDetectRegion?: boolean;
}

export interface SaveConnectionResponse {
  success: boolean;
  connectionId: number;
  region: string;
  bucket: string | null;
  endpoint: string | null;
}

export interface AuthStatus {
  authenticated: boolean;
}

export interface BucketsResponse {
  buckets: BucketInfo[];
}

export interface ValidateBucketResponse {
  success: boolean;
  bucket: string;
}

export interface ServerSavedConnection {
  id: number;
  profileName: string;
  endpoint: string;
  accessKeyId: string;
  // Note: secretAccessKey is never returned from server for security
  bucket: string | null;
  region: string | null;
  autoDetectRegion: boolean;
  lastUsedAt: number;
}

export interface ConnectionsResponse {
  connections: ServerSavedConnection[];
}

export interface ExportProfileResponse {
  filename: string;
  content: string;
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

export async function saveConnection(credentials: S3ConnectionCredentials): Promise<SaveConnectionResponse> {
  const response = await apiPost<SaveConnectionResponse>('/auth/connections', credentials);
  if (!response) {
    throw new Error('Failed to save connection: empty response');
  }
  return response;
}

export async function listBuckets(connectionId: number): Promise<BucketInfo[]> {
  const response = await apiGet<BucketsResponse>(`/auth/buckets/${connectionId}`);
  if (!response) {
    throw new Error('Failed to list buckets: empty response');
  }
  return response.buckets;
}

export async function validateBucket(connectionId: number, bucket: string): Promise<ValidateBucketResponse> {
  const response = await apiPost<ValidateBucketResponse>(`/auth/validate-bucket/${connectionId}`, { bucket });
  if (!response) {
    throw new Error('Failed to validate bucket: empty response');
  }
  return response;
}

export async function getConnections(): Promise<ServerSavedConnection[]> {
  const response = await apiGet<ConnectionsResponse>('/auth/connections');
  if (!response) {
    throw new Error('Failed to get connections: empty response');
  }
  return response.connections;
}

export async function getConnection(connectionId: number): Promise<ServerSavedConnection> {
  const response = await apiGet<ServerSavedConnection>(`/auth/connections/${connectionId}`);
  if (!response) {
    throw new Error('Failed to get connection: empty response');
  }
  return response;
}

export async function deleteConnectionFromServer(connectionId: number): Promise<void> {
  await apiDelete(`/auth/connections/${connectionId}`);
}

export async function exportConnectionProfile(
  connectionId: number,
  format: 'aws' | 'rclone',
  bucket?: string
): Promise<ExportProfileResponse> {
  if (!Number.isInteger(connectionId) || connectionId < 1) {
    throw new Error('Invalid connection ID');
  }

  const trimmedBucket = bucket?.trim();
  const response = await apiPost<ExportProfileResponse>(
    `/auth/connections/${connectionId}/export`,
    {
      format,
      bucket: trimmedBucket ? trimmedBucket : undefined,
    }
  );

  if (!response) {
    throw new Error('Failed to export profile: empty response');
  }

  return response;
}
