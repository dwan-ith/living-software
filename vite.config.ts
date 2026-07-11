import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function wsTargetFromHttp(url: string) {
  return url.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const backendUrl = env.VITE_BACKEND_URL || 'http://127.0.0.1:3000'

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': backendUrl,
        '/observer-ws': {
          target: wsTargetFromHttp(backendUrl),
          ws: true,
          rewrite: () => '/',
        },
      },
    },
  }
})
