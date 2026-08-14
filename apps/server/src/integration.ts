export function parseIntegrationRequired(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === '0' || normalized === 'false') return false;
  if (normalized === '1' || normalized === 'true') return true;
  throw new Error('WW_REQUIRE_INTEGRATION yalnızca 1/true veya 0/false olabilir');
}

export function integrationRequired(): boolean {
  return parseIntegrationRequired(process.env['WW_REQUIRE_INTEGRATION']);
}
