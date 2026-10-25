"use client";
// ABOUTME: Воспроизводит экран и OTP форму входа Brai-old.
// ABOUTME: Не хранит сессию; использует HTTP операции владельца аккаунта.
import type { CSSProperties, FormEvent } from "react";
import { useId, useRef, useState } from "react";
import { KeyRound, Loader2, Mail } from "lucide-react";
import { AuthOtpEntry, type AuthOtpTimer } from "@/components/ui/auth-otp-entry";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import { LoginGalaxy } from "../shell/login-galaxy";
import "./auth.css";
export type OtpSendResult = { expires_in_seconds?: number; resend_after_seconds?: number; resend_strategy?: "reuse" | "replace" };
/** Сохраняет уточняющее сообщение HTTP адаптера при неоднозначном результате входа. */
export class AuthRequestError extends Error {}
export const authDarkThemeStyle = {
  "--background": "#050607",
  "--foreground": "#f4f4f5",
  "--card": "rgb(15 17 21 / 0.7)",
  "--card-foreground": "#f4f4f5",
  "--popover": "#0f1115",
  "--popover-foreground": "#f4f4f5",
  "--primary": "#f4f4f5",
  "--primary-foreground": "#15171a",
  "--secondary": "#1b2026",
  "--secondary-foreground": "#f4f4f5",
  "--muted": "#1b2026",
  "--muted-foreground": "#a1a1aa",
  "--accent": "#20252d",
  "--accent-foreground": "#f4f4f5",
  "--border": "#2a3038",
  "--input": "#343a44",
  "--ring": "#d4d4d8",
} as CSSProperties;

/** Показывает самостоятельную тёмную страницу входа без рабочей оболочки. */
export function AuthScreen(props: { busy: boolean; onRequestOtp: (email: string) => Promise<OtpSendResult>; onVerifyOtp: (email: string, otp: string) => Promise<void> }) {
 return <main className="brai-auth-page dark relative isolate grid min-h-dvh place-items-center overflow-hidden bg-background px-4 py-10 text-foreground" style={authDarkThemeStyle} data-auth-page data-theme="dark">
  <LoginGalaxy />
  <div className="relative z-10 grid w-full max-w-md justify-items-center gap-4">
   <AuthPanel {...props} />
   <a className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline" href="https://brai.one/">На главную</a>
  </div>
 </main>;
}
/** Отображает исходную OTP форму; сетевые операции и сессия принадлежат Account. */
export function AuthPanel({
  busy,
  className = "m-0",
  onAuthenticated,
  onRequestOtp,
  onVerifyOtp,
}: {
  busy: boolean;
  className?: string;
  onAuthenticated?: () => void;
  onRequestOtp: (email: string) => Promise<OtpSendResult>;
  onVerifyOtp: (email: string, otp: string) => Promise<void>;
}) {
  const inputId = useId();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpFocusKey, setOtpFocusKey] = useState(0);
  const [otpTimer, setOtpTimer] = useState<AuthOtpTimer>(defaultOtpTimer);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const pending = busy || submitting;

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    let authenticated = false;
    try {
      if (!otpSent) {
        await requestOtpCode();
        return;
      }
      await onVerifyOtp(email, otp);
      onAuthenticated?.();
      authenticated = true;
    } catch (error) {
      setError(error instanceof AuthRequestError ? error.message : otpSent ? "Не удалось проверить код" : "Не удалось отправить код");
    } finally {
      if (!authenticated) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }

  async function requestOtpCode() {
    setOtpSent(true);
    setOtp("");
    setOtpTimer((current) => ({ ...current, sentAtMs: null }));
    setOtpFocusKey((current) => current + 1);
    try {
      applyOtpResult(await onRequestOtp(email));
    } catch (error) {
      setOtpSent(false);
      throw error;
    }
  }

  async function resendOtpCode() {
    setError("");
    setOtp("");
    try { applyOtpResult(await onRequestOtp(email)); }
    catch (error) { setError(error instanceof AuthRequestError ? error.message : "Не удалось отправить код"); }
  }

  const emailInputId = `${inputId}-email`;
  const otpInputId = `${inputId}-otp`;

  return (
    <Card
      className={cn(className, "w-full backdrop-blur-md sm:max-w-md")}
      style={authDarkThemeStyle}
      render={<form onSubmit={submitAuth} />}
    >
      <CardHeader>
        <CardTitle>Вход в Brai</CardTitle>
        <CardDescription>
          Введите почту, чтобы получить код для входа или регистрации.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-4">
          <Field data-invalid={Boolean(error && (!otpSent))}>
            <FieldLabel htmlFor={emailInputId}>Почта</FieldLabel>
            <Input
              id={emailInputId}
              value={email}
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="Введите почту"
              aria-label="Email"
              aria-invalid={Boolean(error && (!otpSent))}
              disabled={pending || (otpSent)}
              onChange={(event) => setEmail(event.target.value)}
            />
            <FieldDescription>
              Мы отправим одноразовый код на эту почту.
            </FieldDescription>
          </Field>
          <div className="h-[140px]">
            {otpSent ? (
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor={otpInputId}>Код</FieldLabel>
                <AuthOtpEntry
                  id={otpInputId}
                  value={otp}
                  timer={otpTimer}
                  autoFocusKey={otpFocusKey}
                  ariaInvalid={Boolean(error)}
                  disabled={pending && otpTimer.sentAtMs !== null}
                  onChange={setOtp}
                  onResend={resendOtpCode}
                />
              </Field>
            ) : (
              <div className="invisible h-full" aria-hidden="true" />
            )}
          </div>
          <div className="min-h-5">
            {error ? <FieldError>{error}</FieldError> : null}
          </div>
        </FieldGroup>
      </CardContent>
      <CardFooter>
        <Button className="w-full" disabled={pending || !email || (otpSent && !otp)} aria-busy={pending}>
          {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : otpSent ? <KeyRound aria-hidden="true" /> : <Mail aria-hidden="true" />}
          {otpSent ? "Войти" : "Получить код"}
        </Button>
      </CardFooter>
    </Card>
  );

  function applyOtpResult(result: OtpSendResult) {
    const nowMs = Date.now();
    const previousSentAtMs = otpTimer.sentAtMs;
    const previousStillValid =
      previousSentAtMs !== null && nowMs < previousSentAtMs + otpTimer.expiresInSeconds * 1000;
    setOtpTimer({
      sentAtMs: result.resend_strategy === "reuse" && previousStillValid ? previousSentAtMs : nowMs,
      expiresInSeconds: positiveSeconds(result.expires_in_seconds, defaultOtpTimer.expiresInSeconds),
      resendAfterSeconds: positiveSeconds(result.resend_after_seconds, defaultOtpTimer.resendAfterSeconds),
    });
    setOtpFocusKey((current) => current + 1);
  }
}

const defaultOtpTimer: AuthOtpTimer = {
  sentAtMs: null,
  expiresInSeconds: 5 * 60,
  resendAfterSeconds: 60,
};

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

