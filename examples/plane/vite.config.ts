import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// WebGPU only exists in secure contexts (https or localhost). Phones reach the
// dev server through a LAN address, so `pnpm dev:phone` serves it over https
// with a self-signed certificate.
export default defineConfig(({ mode }) => ({
  plugins: mode === 'phone' ? [basicSsl()] : [],
  server: { host: true, port: 5174 },
  build: { target: 'es2023' },
}));
