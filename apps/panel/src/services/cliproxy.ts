import { getJson, type RequestOptions } from './http.js';

export type CliproxyGatewayState = 'not_configured' | 'unreachable' | 'unauthorized' | 'connected';

export interface CliproxyGatewayStatus {
  state: CliproxyGatewayState;
  baseUrl: string;
  managementUrl: string;
  modelCount: number | null;
  accountCount: number | null;
}

export function fetchCliproxyStatus(options: RequestOptions = {}): Promise<CliproxyGatewayStatus> {
  return getJson<CliproxyGatewayStatus>('/gateway/cliproxy', options, 'CLIProxyAPI durumu okunamadı');
}
