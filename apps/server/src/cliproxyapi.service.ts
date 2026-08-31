import { Injectable } from '@nestjs/common';

export type CliproxyGatewayState = 'not_configured' | 'unreachable' | 'unauthorized' | 'connected';

export interface CliproxyGatewayStatus {
  readonly state: CliproxyGatewayState;
  readonly baseUrl: string;
  readonly managementUrl: string;
  readonly modelCount: number | null;
  readonly accountCount: number | null;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8317';

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function managementUrl(baseUrl: string): string {
  return `${baseUrl}/management.html`;
}

@Injectable()
export class CliproxyApiService {
  status(): Promise<CliproxyGatewayStatus> {
    const enabled = process.env['WW_CLIPROXY_ENABLED'] === '1';
    const baseUrl = normalizeBaseUrl(process.env['WW_CLIPROXY_BASE_URL'] ?? DEFAULT_BASE_URL);
    const management = managementUrl(baseUrl);
    if (!enabled) return Promise.resolve({ state: 'not_configured', baseUrl, managementUrl: management, modelCount: null, accountCount: null });

    const key = process.env['WW_CLIPROXY_MANAGEMENT_KEY']?.trim() ?? '';
    if (key.length === 0) return Promise.resolve({ state: 'unauthorized', baseUrl, managementUrl: management, modelCount: null, accountCount: null });
    return this.#probe(baseUrl, key, management);
  }

  async #probe(baseUrl: string, key: string, management: string): Promise<CliproxyGatewayStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_500);
    try {
      const response = await fetch(`${baseUrl}/v0/management/config`, {
        headers: { Authorization: `Bearer ${key}` }, signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) return { state: 'unauthorized', baseUrl, managementUrl: management, modelCount: null, accountCount: null };
      if (!response.ok) return { state: 'unreachable', baseUrl, managementUrl: management, modelCount: null, accountCount: null };
      const value: unknown = await response.json();
      const config = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
      const accounts = Array.isArray(config['api-keys']) ? config['api-keys'].length : null;
      const models = Array.isArray(config['model-mapping']) ? config['model-mapping'].length : null;
      return { state: 'connected', baseUrl, managementUrl: management, modelCount: models, accountCount: accounts };
    } catch {
      return { state: 'unreachable', baseUrl, managementUrl: management, modelCount: null, accountCount: null };
    } finally {
      clearTimeout(timeout);
    }
  }
}
