export const queryKeys = {
  connections: ['connections'] as const,
  connection: (connectionId: number) => ['connections', connectionId] as const,
  buckets: (connectionId: number) => ['buckets', connectionId] as const,
};
