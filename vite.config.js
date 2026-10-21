import process from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// `npm run build:profile` swaps in React's profiling build so <Profiler>
// reports commit counts and durations in an otherwise production bundle.
export default defineConfig({
  plugins: [react()],
  resolve: process.env.PROFILE
    ? { alias: { 'react-dom/client': 'react-dom/profiling' } }
    : {},
})
