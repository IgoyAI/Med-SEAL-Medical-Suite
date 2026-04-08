import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { mockApiPlugin } from './dev-mock-api.js'

export default defineConfig({
  plugins: [react(), mockApiPlugin()],
})
