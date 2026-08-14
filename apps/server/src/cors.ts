const DEFAULT_PANEL_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`geçersiz panel origin: ${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`panel origin http/https olmalıdır: ${value}`);
  }
  if (url.username || url.password) {
    throw new Error(`panel origin kimlik bilgisi içeremez: ${value}`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`panel origin path, query veya fragment içeremez: ${value}`);
  }
  return url.origin;
}

export function panelOrigins(value = process.env['WW_PANEL_ORIGINS']): string[] {
  if (!value?.trim()) return [...DEFAULT_PANEL_ORIGINS];

  const configured = value.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (configured.length === 0) throw new Error('WW_PANEL_ORIGINS en az bir origin içermelidir');
  return [...new Set(configured.map(normalizeOrigin))];
}
