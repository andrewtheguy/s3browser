import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Navigate, useSearchParams } from 'react-router';
import { BrandMark, Wordmark } from '@/components/BrandMark';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useSession } from '../contexts/SessionContext';
import { CONNECTIONS_URL, isSafeReturnPath } from '../utils/urlEncoding';

export function LoginPage() {
  const { isLoggedIn, isCheckingSession, serverError, login, retry } = useSession();
  const [searchParams] = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const requestedNext = searchParams.get('next');
  const next = requestedNext && isSafeReturnPath(requestedNext) ? requestedNext : CONNECTIONS_URL;

  useEffect(() => {
    document.title = 'Sign in - s3browser';
  }, []);

  if (isLoggedIn) {
    return <Navigate to={next} replace />;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-linear-to-br from-brand via-brand-2 to-brand-3 p-4">
      <Card className="w-full max-w-sm border-white/10 shadow-2xl shadow-black/30">
        <CardContent className="p-6 sm:p-8">
          <div className="mb-6 flex flex-col items-center gap-3">
            <BrandMark className="h-14 w-14" />
            <h1 className="text-2xl">
              <Wordmark />
            </h1>
          </div>

          {isCheckingSession ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <Spinner size="lg" />
              <p className="text-sm text-muted-foreground">Connecting to server…</p>
            </div>
          ) : serverError ? (
            <div className="flex flex-col items-center text-center">
              <AlertCircle className="mb-3 h-10 w-10 text-destructive" />
              <h2 className="mb-1 font-semibold">Server unreachable</h2>
              <p className="mb-5 text-sm text-muted-foreground">{serverError}</p>
              <Button onClick={retry} className="h-11 w-full">
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-center text-sm text-muted-foreground">Enter the password to continue</p>
              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
                autoFocus
                className="h-11"
              />
              <Button type="submit" className="h-11 w-full" disabled={!password || isSubmitting}>
                {isSubmitting ? <Spinner size="sm" className="text-primary-foreground" /> : 'Sign in'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
