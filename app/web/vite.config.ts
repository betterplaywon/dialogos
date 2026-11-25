// 화면을 만드는 설정. /api는 개발 중에 같은 컴퓨터의 서버로 넘긴다(npm run app:dev가 함께 띄운다).

import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { portsFromEnv } from '../server/port.ts';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const nodeModules = fileURLToPath(new URL('../../node_modules', import.meta.url));
// 개발 서버(app/dev.ts)와 같은 환경 변수를 같은 함수로 읽는다. 값이 틀리면 개발 서버가 먼저 멈춘다.
const ports = portsFromEnv(process.env);

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: ports.web,
    // 포트가 쓰이고 있으면 다음 포트로 옮기지 않고 멈춘다. 옮기면 같은 컴퓨터의 다른 개발 서버 자리에 뜰 수 있다.
    strictPort: true,
    // 서버가 주소(Host)를 확인하므로, 넘길 때 주소를 서버의 것으로 바꾼다.
    proxy: { '/api': { target: `http://127.0.0.1:${ports.api}`, changeOrigin: true } },
    // 기본값은 저장소 전체라, 개인 메모(notes/)와 로컬 규칙 같은 파일도 /@fs/로 내준다. 화면과 의존성만 내주게 좁힌다.
    fs: { allow: [webRoot, nodeModules] },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
