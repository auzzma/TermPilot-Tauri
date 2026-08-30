import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "../i18n";

export function RevealablePasswordInput({
  value,
  placeholder,
  onChange,
  autoFocus,
  autoComplete = "new-password",
  className,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  autoComplete?: string;
  className?: string;
}) {
  const t = useTranslation();
  const [isRevealed, setIsRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number>();

  useEffect(
    () => () => {
      if (copyResetRef.current != null) {
        window.clearTimeout(copyResetRef.current);
      }
    },
    [],
  );

  async function copyPassword() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (copyResetRef.current != null) {
        window.clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; leave the field untouched.
    }
  }

  return (
    <div
      className={
        className
          ? `revealable-password-field ${className}`
          : "revealable-password-field"
      }
    >
      <input
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        placeholder={placeholder}
        type={isRevealed ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        aria-label={t(isRevealed ? "Hide Password" : "Show Password")}
        title={t(isRevealed ? "Hide Password" : "Show Password")}
        type="button"
        onClick={() => setIsRevealed((current) => !current)}
      >
        {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
      <button
        aria-label={t("Copy Password")}
        disabled={!value}
        title={t("Copy Password")}
        type="button"
        onClick={() => void copyPassword()}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}
