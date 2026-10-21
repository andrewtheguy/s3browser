/**
 * Lets the API client tell the session layer that the server rejected the
 * login cookie, without the client knowing anything about React.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitUnauthorized(): void {
  for (const listener of listeners) {
    listener();
  }
}
