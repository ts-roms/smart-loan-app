import { ApiError, useLogin } from '@loan/api-client';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, useToast } from '@loan/ui';
import { Lock, Wallet } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../../providers/auth';

/**
 * Sign-in. After a successful POST we stash the token + user in the
 * auth provider; the App's router will swing over to the dashboard
 * automatically on the next render.
 */
export function LoginPage() {
  const { signIn } = useAuth();
  const login = useLogin();
  const navigate = useNavigate();
  const toast = useToast();
  const [email, setEmail] = useState('admin@loan.local');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [requires2fa, setRequires2fa] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await login.mutateAsync({
        email,
        password,
        ...(useRecovery ? { recoveryCode } : { totpCode: totpCode || undefined }),
      });
      signIn({
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        user: res.user,
      });
      navigate('/', { replace: true });
    } catch (err) {
      // Server signals "needs 2FA" via a 401 with `requires2fa: true` in
      // the body. Switch the form into 2FA mode instead of toasting an
      // error — keeps the password the user just typed and prompts for
      // the code.
      if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'requires2fa' in err.body) {
        setRequires2fa(true);
        if (totpCode || recoveryCode) {
          toast.error((err as Error).message ?? 'Wrong 2FA code');
        }
        return;
      }
      toast.error((err as Error).message ?? 'Sign-in failed');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Wallet className="h-6 w-6 text-sky-300" />
            <span className="text-xl font-semibold">SmartLoan</span>
          </div>
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm">Email</label>
              <Input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm">Password</label>
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {requires2fa && !useRecovery && (
              <div className="space-y-1">
                <label className="text-sm flex items-center gap-1">
                  <Lock className="h-3 w-3" /> 6-digit code
                </label>
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setUseRecovery(true)}
                  className="text-[10px] text-white/55 underline mt-1"
                >
                  Lost your device? Use a recovery code instead
                </button>
              </div>
            )}
            {requires2fa && useRecovery && (
              <div className="space-y-1">
                <label className="text-sm flex items-center gap-1">
                  <Lock className="h-3 w-3" /> Recovery code
                </label>
                <Input
                  placeholder="XXXX-XXXX"
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setUseRecovery(false)}
                  className="text-[10px] text-white/55 underline mt-1"
                >
                  Back to TOTP code
                </button>
              </div>
            )}
            <Button type="submit" className="w-full" disabled={login.isPending}>
              {login.isPending ? 'Signing in…' : requires2fa ? 'Verify and sign in' : 'Sign in'}
            </Button>
            <p className="text-xs text-white/45 text-center pt-2">
              Default admin · admin@loan.local / P@ssw0rd123
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
