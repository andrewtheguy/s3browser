const API_BASE = '/api';

export interface ApiError {
  error: string;
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T | null> {
  const url = `${API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    let errorMessage = `Request failed with status ${response.status}`;
    try {
      const text = await response.text();
      if (text) {
        const parsed = JSON.parse(text);
        errorMessage = parsed.error || errorMessage;
      }
    } catch {
      // Failed to parse error response, use default message
    }
    throw new Error(errorMessage);
  }

  // Handle empty responses (204 No Content or empty body)
  const contentLength = response.headers.get('content-length');
  const contentType = response.headers.get('content-type');

  if (response.status === 204 || contentLength === '0') {
    return null;
  }

  // Reject unexpected non-JSON responses
  if (!contentType?.includes('application/json')) {
    throw new Error(`Unexpected content type: ${contentType || 'none'}`);
  }

  return response.json();
}

export async function apiGet<T>(endpoint: string): Promise<T | null> {
  return apiRequest<T>(endpoint, { method: 'GET' });
}

export async function apiPost<T>(endpoint: string, body?: unknown): Promise<T | null> {
  return apiRequest<T>(endpoint, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function apiDelete<T>(endpoint: string): Promise<T | null> {
  return apiRequest<T>(endpoint, { method: 'DELETE' });
}
