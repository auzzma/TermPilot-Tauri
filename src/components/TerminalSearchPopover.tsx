import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp } from "lucide-react";

import { useTranslation } from "../i18n";

interface TerminalSearchPopoverProps {
  anchor: HTMLElement | null;
  value: string;
  summary: string;
  onChange: (value: string) => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onClose: () => void;
}

export function TerminalSearchPopover({
  anchor,
  value,
  summary,
  onChange,
  onFindNext,
  onFindPrevious,
  onClose,
}: TerminalSearchPopoverProps) {
  const t = useTranslation();
  const popoverRef = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<TerminalSearchPopoverPosition>();

  useLayoutEffect(() => {
    const update = () => {
      if (!anchor) return;
      setPosition(
        terminalSearchPopoverPosition(
          anchor.getBoundingClientRect(),
          284,
          92,
          window.innerWidth,
          window.innerHeight,
        ),
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        anchor?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [anchor, onClose]);

  if (!position) return null;

  return createPortal(
    <section
      ref={popoverRef}
      className={`terminal-search-popover is-${position.placement}`}
      role="dialog"
      aria-label={t("Search terminal")}
      style={{
        left: position.left,
        top: position.top,
        "--terminal-search-arrow-left": `${position.arrowLeft}px`,
      } as CSSProperties}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <input
        autoFocus
        aria-label={t("Find")}
        placeholder={t("Find")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.shiftKey ? onFindPrevious() : onFindNext();
          }
          if (event.key === "Escape") onClose();
        }}
      />
      <footer>
        <div className="terminal-search-navigation">
          <button
            type="button"
            title={t("Find previous")}
            disabled={!value}
            onClick={onFindPrevious}
          >
            <ChevronUp size={18} strokeWidth={2.4} />
          </button>
          <button
            type="button"
            title={t("Find next")}
            disabled={!value}
            onClick={onFindNext}
          >
            <ChevronDown size={18} strokeWidth={2.4} />
          </button>
        </div>
        {summary ? <span>{t(summary)}</span> : null}
        <button
          className="terminal-search-done"
          type="button"
          onClick={onClose}
        >
          {t("Done")}
        </button>
      </footer>
    </section>,
    document.body,
  );
}

export interface TerminalSearchPopoverPosition {
  left: number;
  top: number;
  arrowLeft: number;
  placement: "top" | "bottom";
}

export function terminalSearchPopoverPosition(
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width">,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): TerminalSearchPopoverPosition {
  const inset = 8;
  const gap = 12;
  const center = anchor.left + anchor.width / 2;
  const left = Math.max(
    inset,
    Math.min(center - width / 2, viewportWidth - width - inset),
  );
  const fitsBelow = anchor.bottom + gap + height <= viewportHeight - inset;
  const placement = fitsBelow ? "bottom" : "top";
  const top = fitsBelow
    ? anchor.bottom + gap
    : Math.max(inset, anchor.top - gap - height);

  return {
    left,
    top,
    arrowLeft: Math.max(20, Math.min(center - left, width - 20)),
    placement,
  };
}
