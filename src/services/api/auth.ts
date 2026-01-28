import { apiPost, apiGet } from './client';

export interface LoginCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
}

export interface LoginResponse {
  success: boolean;
  region: string;
  bucket: string;
}

export interface AuthStatus {
  authenticated: boolean;
  region?: string;
  bucket?: string;
}

export async function login(credentials: LoginCredentials): Promise<LoginResponse> {
  return apiPost<LoginResponse>('/auth/login', credentials);
}

export async function logout(): Promise<void> {
  await apiPost('/auth/logout');
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return apiGet<AuthStatus>('/auth/status');
}
