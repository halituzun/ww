import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

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
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = apiProxyTarget(
    env['VITE_API_PROXY_TARGET'] || 'http://localhost:4000',
  );

  return {
    plugins: [react()],
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
