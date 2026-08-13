const STORAGE_KEY = 'telgamax_api_key';

export function getStoredApiKey(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setStoredApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key);
}

export function clearStoredApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Attaches the stored API key to every request; the caller handles a 401 by clearing it and re-prompting. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const apiKey = getStoredApiKey();
  const headers = new Headers(init.headers);
  if (apiKey) headers.set('x-api-key', apiKey);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(path, { ...init, headers });
}

export function openStatusSocket(): WebSocket {
  const apiKey = getStoredApiKey() ?? '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${protocol}//${window.location.host}/ws?apiKey=${encodeURIComponent(apiKey)}`);
}
