import { apiPost, apiGet, apiDelete } from './client';
import type { BucketInfo } from '../../types';

export interface UserLoginCredentials {
  username: string;
  password: string;
}

export interface UserLoginResponse {
  success: boolean;
  username: string;
}

export interface LoginCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  bucket?: string;
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
  userLoggedIn: boolean;
  username?: string;
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

export interface ServerSavedConnection {
  name: string;
  endpoint: string;
  bucket: string | null;
  region: string | null;
  autoDetectRegion: boolean;
  lastUsedAt: number;
}

export interface ConnectionsResponse {
  connections: ServerSavedConnection[];
}

export interface AccessKeyResponse {
  accessKeyId: string;
}

export async function userLogin(credentials: UserLoginCredentials): Promise<UserLoginResponse> {
  const response = await apiPost<UserLoginResponse>('/auth/user-login', credentials);
  if (!response) {
    throw new Error('Login failed: empty response');
  }
  return response;
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

export async function getConnections(): Promise<ServerSavedConnection[]> {
  const response = await apiGet<ConnectionsResponse>('/auth/connections');
  if (!response) {
    throw new Error('Failed to get connections: empty response');
  }
  return response.connections;
}

export async function saveConnectionToServer(connection: {
  name: string;
  endpoint: string;
  accessKeyId: string;
  bucket?: string;
  region?: string;
  autoDetectRegion?: boolean;
}): Promise<void> {
  await apiPost('/auth/connections', connection);
}

export async function deleteConnectionFromServer(name: string): Promise<void> {
  await apiDelete(`/auth/connections/${encodeURIComponent(name)}`);
}

export async function getConnectionAccessKey(name: string): Promise<string> {
  const response = await apiGet<AccessKeyResponse>(`/auth/connections/${encodeURIComponent(name)}/accesskey`);
  if (!response) {
    throw new Error('Failed to get access key: empty response');
  }
  return response.accessKeyId;
}
