const API_BASE = '/api';

export interface ApiError {
  error: string;
}

export class ApiHttpError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiHttpError';
    this.status = status;
    this.code = code;
  }
}

interface ApiRequestOptions extends RequestInit {
  responseType?: 'json' | 'text';
}

export async function apiRequest<T>(
  endpoint: string,
  options: ApiRequestOptions = {}
): Promise<T | null> {
  const { responseType = 'json', ...fetchOptions } = options;
  const url = `${API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...fetchOptions,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
  });

  if (!response.ok) {
    let errorMessage = `Request failed with status ${response.status}`;
    let errorCode: string | undefined;
    try {
      const text = await response.text();
      if (text) {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
          const errorValue = (parsed as { error: unknown }).error;
          if (typeof errorValue === 'string') {
            errorMessage = errorValue;
          }
        }
        if (typeof parsed === 'object' && parsed !== null && 'code' in parsed) {
          const codeValue = (parsed as { code: unknown }).code;
          if (typeof codeValue === 'string') {
            errorCode = codeValue;
          }
        }
      }
    } catch {
      // Failed to parse error response, use default message
    }
    throw new ApiHttpError(errorMessage, response.status, errorCode);
  }

  // Handle empty responses (204 No Content or empty body)
  const contentLength = response.headers.get('content-length');
  const contentType = response.headers.get('content-type');

  if (response.status === 204 || contentLength === '0') {
    return null;
  }

  if (responseType === 'text') {
    return response.text() as Promise<T>;
  }

  // Reject unexpected non-JSON responses
  if (!contentType?.includes('application/json')) {
    throw new Error(`Unexpected content type: ${contentType || 'none'}`);
  }

  return response.json() as Promise<T>;
}

export function apiGet<T>(endpoint: string, signal?: AbortSignal): Promise<T | null> {
  return apiRequest<T>(endpoint, { method: 'GET', signal });
}

export function apiGetText(endpoint: string, signal?: AbortSignal): Promise<string | null> {
  return apiRequest<string>(endpoint, { method: 'GET', signal, responseType: 'text' });
}

export function apiPost<T>(endpoint: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
  return apiRequest<T>(endpoint, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
}

export function apiDelete<T>(endpoint: string, signal?: AbortSignal): Promise<T | null> {
  return apiRequest<T>(endpoint, { method: 'DELETE', signal });
}
