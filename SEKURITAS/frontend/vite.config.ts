import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['mandala-sekuritas.michaelk.fun'],
  },
  preview: {
    allowedHosts: ['mandala-sekuritas.michaelk.fun'],
  },
})
