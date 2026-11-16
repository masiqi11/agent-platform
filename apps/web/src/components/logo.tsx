export function Logo({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <path d="M9 20.5c2.2-5.6 4.4-8.4 7-8.4s4.8 2.8 7 8.4" stroke="var(--primary-foreground)" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <circle cx="16" cy="10" r="2.3" fill="var(--signal-attention)" />
    </svg>
  );
}
