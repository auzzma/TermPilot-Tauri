export function SidebarToggleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <rect
        height="16"
        rx="2.75"
        stroke="currentColor"
        strokeWidth="1.8"
        width="20"
        x="2"
        y="4"
      />
      <path
        d="M9 4v16M5.25 8h.75M5.25 12h.75M5.25 16h.75"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
