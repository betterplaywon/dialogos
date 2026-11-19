// 화면을 만드는 설정. /api는 개발 중에 같은 컴퓨터의 서버로 넘긴다(npm run app:dev가 함께 띄운다).

import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { API_PORT } from '../server/port.ts';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const nodeModules = fileURLToPath(new URL('../../node_modules', import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // 서버가 주소(Host)를 확인하므로, 넘길 때 주소를 서버의 것으로 바꾼다.
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true } },
    // 기본값은 저장소 전체라, 개인 메모(notes/)와 로컬 규칙 같은 파일도 /@fs/로 내준다. 화면과 의존성만 내주게 좁힌다.
    fs: { allow: [webRoot, nodeModules] },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
