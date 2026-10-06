"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";

const OTP_LENGTH = 6;

export type AuthOtpTimer = {
  sentAtMs: number | null;
  expiresInSeconds: number;
  resendAfterSeconds: number;
};

export function AuthOtpEntry({
  ariaInvalid,
  autoFocusKey,
  disabled,
  id,
  onChange,
  onResend,
  resendDisabled,
  timer,
  value,
}: {
  ariaInvalid?: boolean;
  autoFocusKey: number;
  disabled?: boolean;
  id?: string;
  onChange: (value: string) => void;
  onResend: () => Promise<void>;
  resendDisabled?: boolean;
  timer: AuthOtpTimer;
  value: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const secondsSinceSent = timer.sentAtMs ? Math.max(0, Math.floor((nowMs - timer.sentAtMs) / 1000)) : 0;
  const codeSecondsLeft = timer.sentAtMs ? Math.max(0, timer.expiresInSeconds - secondsSinceSent) : timer.expiresInSeconds;
  const resendSecondsLeft = timer.sentAtMs ? Math.max(0, timer.resendAfterSeconds - secondsSinceSent) : timer.resendAfterSeconds;
  const resendReady = timer.sentAtMs != null && resendSecondsLeft <= 0;
  const hint = timer.sentAtMs ? `Код действителен ${formatCountdown(codeSecondsLeft)}` : "Код отправляется...";
  const resendLabel = resendReady ? "Отправить повторно" : `Отправить повторно через ${formatCountdown(resendSecondsLeft)}`;

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [autoFocusKey]);

  const slots = useMemo(() => Array.from({ length: OTP_LENGTH }, (_, index) => index), []);

  return (
    <div className="grid gap-2">
      <InputOTP
        ref={inputRef}
        id={id}
        value={value}
        maxLength={OTP_LENGTH}
        pattern={REGEXP_ONLY_DIGITS}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="Код из письма"
        aria-invalid={ariaInvalid}
        data-testid="auth-otp-input"
        disabled={disabled}
        onChange={onChange}
      >
        <InputOTPGroup>
          {slots.slice(0, 3).map((index) => <InputOTPSlot key={index} index={index} />)}
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          {slots.slice(3).map((index) => <InputOTPSlot key={index} index={index} />)}
        </InputOTPGroup>
      </InputOTP>
      <p className="m-0 text-sm text-muted-foreground">{hint}</p>
      <Button type="button" variant="outline" size="sm" disabled={disabled || resendDisabled || !resendReady} onClick={onResend}>
        <RefreshCw aria-hidden="true" />
        {resendLabel}
      </Button>
    </div>
  );
}

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
