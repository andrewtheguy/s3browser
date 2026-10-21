import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { setPresignedUrlTtlOptions } from './config/presignedUrls'
import { getServerConfig } from './services/api/config'

void getServerConfig()
  .then((config) => {
    setPresignedUrlTtlOptions(config.presignedUrlTtls);
  })
  .catch((err) => {
    console.warn('Failed to load server config; using defaults', err);
  });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
