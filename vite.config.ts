import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Firebase Hosting builds use the root path; GitHub Pages sets this to
  // /SistemaPolleria/ in its workflow.
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
})
