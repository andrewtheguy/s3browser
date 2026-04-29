import { apiGet } from './client';
import type { PresignedUrlTtlOption } from '../../config/presignedUrls';

export interface ServerConfig {
  presignedUrlTtls: PresignedUrlTtlOption[];
}

export async function getServerConfig(signal?: AbortSignal): Promise<ServerConfig> {
  const response = await apiGet<ServerConfig>('/config', signal);
  if (!response) {
    throw new Error('Failed to load server config: empty response');
  }
  return response;
}
