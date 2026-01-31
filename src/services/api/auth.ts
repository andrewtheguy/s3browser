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
  connectionName: string;
  autoDetectRegion?: boolean;
}

export interface LoginResponse {
  success: boolean;
  connectionId: number;
  region: string;
  bucket: string | null;
  endpoint?: string;
  requiresBucketSelection: boolean;
}

export interface AuthStatus {
  authenticated: boolean;
  userLoggedIn: boolean;
  username?: string;
  activeConnectionId?: number | null;
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
  id: number;
  name: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string | null;
  region: string | null;
  autoDetectRegion: boolean;
  lastUsedAt: number;
}

export interface ConnectionsResponse {
  connections: ServerSavedConnection[];
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

export async function getConnection(connectionId: number): Promise<ServerSavedConnection> {
  const response = await apiGet<ServerSavedConnection>(`/auth/connections/${connectionId}`);
  if (!response) {
    throw new Error('Failed to get connection: empty response');
  }
  return response;
}

export interface ActivateConnectionResponse {
  success: boolean;
  connectionId: number;
  region: string;
  bucket: string | null;
  endpoint: string | null;
  requiresBucketSelection: boolean;
}

export async function activateConnection(connectionId: number, bucket?: string): Promise<ActivateConnectionResponse> {
  const response = await apiPost<ActivateConnectionResponse>(`/auth/activate-connection/${connectionId}`, { bucket });
  if (!response) {
    throw new Error('Failed to activate connection: empty response');
  }
  return response;
}

export async function deleteConnectionFromServer(connectionId: number): Promise<void> {
  await apiDelete(`/auth/connections/${connectionId}`);
}

