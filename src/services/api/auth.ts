import { apiPost, apiGet } from './client';

export interface LoginCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  bucket: string;
  endpoint?: string;
}

export interface LoginResponse {
  success: boolean;
  region: string;
  bucket: string;
  endpoint?: string;
}

export interface AuthStatus {
  authenticated: boolean;
  region?: string;
  bucket?: string;
  endpoint?: string;
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

export async function getAuthStatus(): Promise<AuthStatus> {
  const response = await apiGet<AuthStatus>('/auth/status');
  if (!response) {
    throw new Error('Failed to get auth status: empty response');
  }
  return response;
}
