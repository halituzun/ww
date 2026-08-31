import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

function apiProxyTarget(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash) {
    throw new Error('VITE_API_PROXY_TARGET geçerli bir http/https origin olmalıdır');
  }
  return url.origin;
}

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, resolve(process.cwd(), '../..'), '');
  const env = { ...rootEnv, ...loadEnv(mode, process.cwd(), '') };
  const serverToken = env['WW_LOCAL_SESSION_TOKEN']?.trim();
  const panelToken = env['VITE_SESSION_TOKEN']?.trim();
  if (serverToken && panelToken && serverToken !== panelToken) {
    throw new Error('VITE_SESSION_TOKEN, WW_LOCAL_SESSION_TOKEN ile aynı olmalıdır');
  }
  if (!panelToken && serverToken) {
    process.env['VITE_SESSION_TOKEN'] = serverToken;
  }
  const proxyTarget = apiProxyTarget(
    env['VITE_API_PROXY_TARGET'] || 'http://localhost:4000',
  );

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_SESSION_TOKEN': JSON.stringify(panelToken || serverToken || ''),
    },
    server: {
      port: 5173,
      proxy: {
        '/health': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
