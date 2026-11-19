// 화면을 만드는 설정. /api는 개발 중에 같은 컴퓨터의 서버로 넘긴다(npm run app:dev가 함께 띄운다).

import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { API_PORT } from '../server/port.ts';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: { '/api': `http://127.0.0.1:${API_PORT}` },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
