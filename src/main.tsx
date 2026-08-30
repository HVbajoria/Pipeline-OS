import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { applicationBootstrap } from './client/bootstrap';
import { PipelineError } from './shared/errors';
import './index.css';

function BootstrappedApp() {
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    const lifecycle = applicationBootstrap.acquire();
    let mounted = true;
    void lifecycle.ready.catch((error) => {
      if (mounted) setBootError(PipelineError.from(error).message);
    });
    return () => {
      mounted = false;
      lifecycle.release();
    };
  }, []);

  return <App bootError={bootError} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BootstrappedApp />
  </StrictMode>,
);
