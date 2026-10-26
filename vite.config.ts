import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { daybookApi } from './server/api.ts'

export default defineConfig({
  plugins: [react(), daybookApi()],
  server: { port: 4321 },
  preview: { port: 4321 },
})
