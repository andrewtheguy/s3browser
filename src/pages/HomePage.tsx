import { useEffect } from 'react';
import { LoginForm } from '../components/LoginForm';

export function HomePage() {
  useEffect(() => {
    document.title = 's3browser';
  }, []);

  return <LoginForm />;
}
