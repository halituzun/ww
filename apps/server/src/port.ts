const DEFAULT_PORT = 4000;

export function parseServerPort(value: string | undefined): number {
  const normalized = value?.trim();
  if (!normalized) return DEFAULT_PORT;
  if (!/^\d+$/.test(normalized)) throw new Error('WW_PORT tam sayı olmalıdır');

  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('WW_PORT 1 ile 65535 arasında olmalıdır');
  }
  return port;
}

export function serverPort(): number {
  return parseServerPort(process.env['WW_PORT']);
}
