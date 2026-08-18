import { useState } from "react";
import { X } from "lucide-react";

import { useTranslation } from "../i18n";

export interface TextPromptState {
  title: string;
  label: string;
  value: string;
  submit: (value: string) => void | Promise<void>;
}

export function TextPrompt({
  prompt,
  onClose,
}: {
  prompt: TextPromptState;
  onClose: () => void;
}) {
  const t = useTranslation();
  const [value, setValue] = useState(prompt.value);
  const submit = () => {
    if (!value.trim()) return;
    void Promise.resolve(prompt.submit(value)).then(onClose);
  };
  return (
    <div className="text-prompt-backdrop">
      <section className="text-prompt" role="dialog" aria-modal="true">
        <header>
          <h3>{t(prompt.title)}</h3>
          <button type="button" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <label>
          <span>{t(prompt.label)}</span>
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
              if (event.key === "Escape") onClose();
            }}
          />
        </label>
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="primary-button" type="button" onClick={submit}>
            {t("Save")}
          </button>
        </footer>
      </section>
    </div>
  );
}
