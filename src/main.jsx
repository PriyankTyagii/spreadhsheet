import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import BenchPage from './bench/BenchPage.jsx'

const isBench = new URLSearchParams(window.location.search).has('bench')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isBench ? <BenchPage /> : <App />}
  </StrictMode>,
)
