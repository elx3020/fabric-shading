import basicSsl from '@vitejs/plugin-basic-ssl';
import { defaultClientConditions, defineConfig } from 'vite';

// WebGPU only exists in secure contexts (https or localhost). Phones reach the
// dev server through a LAN address, so `pnpm dev:phone` serves it over https
// with a self-signed certificate.
export default defineConfig(({ mode }) => ({
  plugins: mode === 'phone' ? [basicSsl()] : [],
  // Use @fabric-shading/core's TypeScript sources directly, so edits there hot-reload without a build.
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: { host: true },
  build: { target: 'es2023' },
}));
