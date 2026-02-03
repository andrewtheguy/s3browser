import { useState, type FormEvent } from 'react';
import { AlertCircle, RefreshCw, LogOut } from 'lucide-react';
import { BucketIcon } from '@/components/ui/bucket-icon';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { useS3Client } from '../../hooks';
import { S3ConnectionForm } from '../S3ConnectionForm';

function PasswordLoginForm({
  error: contextError,
  isLoading,
  setIsLoading,
}: {
  error: string | null;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}) {
  const { login } = useS3Client();
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const error = localError || contextError;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setLocalError(null);

    try {
      await login({ password });
      // isLoggedIn will be updated in context on success
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      console.error('Login error:', err);
      setLocalError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const isFormValid = password.length > 0;

  return (
    <form onSubmit={handleSubmit}>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-4">
        <Input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          autoFocus
        />

        <Button
          type="submit"
          className="w-full"
          size="lg"
          disabled={!isFormValid || isLoading}
        >
          {isLoading ? <Spinner size="sm" className="text-white" /> : 'Sign In'}
        </Button>
      </div>
    </form>
  );
}

export function LoginForm() {
  const { isLoggedIn, error: contextError, serverError, disconnect, retryConnection, isCheckingSession } = useS3Client();
  const [isLoading, setIsLoading] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const error = logoutError || contextError;

  const handleLogout = async () => {
    if (isLoggingOut) {
      return;
    }
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      await disconnect();
    } catch (err) {
      console.error('Logout failed:', err);
      const message = err instanceof Error ? err.message : 'Logout failed';
      setLogoutError(message);
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-[450px] w-full relative overflow-hidden">
        <CardContent className="p-8">
          <div className="flex items-center justify-center mb-6 relative">
            <div className="flex items-center">
              <BucketIcon className="h-10 w-10 mr-2 text-primary" />
              <h1 className="text-2xl font-bold">
                S3 Browser
              </h1>
            </div>
            {isLoggedIn && !serverError && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLogout}
                disabled={isLoggingOut}
                className="absolute -right-4 top-1/2 -translate-y-1/2 h-8 px-2 hover:text-foreground"
              >
                <LogOut className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Sign Out</span>
              </Button>
            )}
          </div>

          {isCheckingSession && !serverError ? (
            <div className="flex flex-col items-center py-8">
              <Spinner size="lg" className="mb-4" />
              <p className="text-sm text-muted-foreground">
                Connecting to server...
              </p>
            </div>
          ) : serverError ? (
            <div className="flex flex-col items-center text-center">
              <AlertCircle className="h-12 w-12 text-destructive mb-4" />
              <h2 className="text-lg font-semibold text-destructive mb-2">
                Server Connection Error
              </h2>
              <p className="text-sm text-muted-foreground mb-6">
                {serverError}
              </p>
              <Button
                onClick={retryConnection}
                disabled={isCheckingSession}
              >
                {isCheckingSession ? (
                  <Spinner size="sm" className="mr-2" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                {isCheckingSession ? 'Connecting...' : 'Retry Connection'}
              </Button>
            </div>
          ) : !isLoggedIn ? (
            <>
              <p className="text-sm text-muted-foreground text-center mb-6">
                Enter password to continue
              </p>

              <PasswordLoginForm
                error={error}
                isLoading={isLoading}
                setIsLoading={setIsLoading}
              />
            </>
          ) : (
            <>
              <S3ConnectionForm
                error={error}
                isLoading={isLoading}
                setIsLoading={setIsLoading}
              />

              <p className="text-xs text-muted-foreground text-center mt-6">
                S3 credentials are encrypted and stored securely. Session expires after 4 hours.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
