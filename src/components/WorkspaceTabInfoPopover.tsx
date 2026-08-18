import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

export interface WorkspaceTabInfo {
  anchor: HTMLElement;
  title: string;
  subtitle?: string;
}

interface WorkspaceTabInfoPopoverProps {
  info?: WorkspaceTabInfo;
}

export function WorkspaceTabInfoPopover({
  info,
}: WorkspaceTabInfoPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] =
    useState<WorkspaceTabInfoPopoverPosition>();

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!info || !popover) {
      setPosition(undefined);
      return;
    }
    const update = () => {
      setPosition(
        workspaceTabInfoPopoverPosition(
          info.anchor.getBoundingClientRect(),
          popover.offsetWidth,
          popover.offsetHeight,
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
  }, [info]);

  if (!info) return null;

  return createPortal(
    <div
      ref={popoverRef}
      className={`workspace-tab-info-popover ${
        position ? `is-${position.placement}` : ""
      }`}
      role="tooltip"
      style={
        position
          ? ({
              left: position.left,
              top: position.top,
            } satisfies CSSProperties)
          : { visibility: "hidden" }
      }
    >
      <strong>{info.title}</strong>
      {info.subtitle ? <span>{info.subtitle}</span> : null}
    </div>,
    document.body,
  );
}

export interface WorkspaceTabInfoPopoverPosition {
  left: number;
  top: number;
  placement: "top" | "bottom";
}

export function workspaceTabInfoPopoverPosition(
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width">,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): WorkspaceTabInfoPopoverPosition {
  const margin = 6;
  const gap = 6;
  const left = Math.min(
    Math.max(anchor.left + anchor.width / 2 - width / 2, margin),
    Math.max(margin, viewportWidth - width - margin),
  );
  const bottomTop = anchor.bottom + gap;
  if (bottomTop + height <= viewportHeight - margin) {
    return { left, top: bottomTop, placement: "bottom" };
  }
  return {
    left,
    top: Math.max(margin, anchor.top - height - gap),
    placement: "top",
  };
}
