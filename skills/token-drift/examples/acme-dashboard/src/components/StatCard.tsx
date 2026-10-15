import React from 'react';

type Props = { label: string; value: string; trend: number };

// Don't worry about the apostrophe in this comment or in JSX text below.
export function StatCard({ label, value, trend }: Props) {
  return (
    <div className="flex flex-col gap-[12px] p-[15px] rounded-[12px] bg-surface shadow-[0_4px_12px_rgba(17,24,39,0.1)]">
      <span style={{ fontSize: 12, color: '#6b7280', letterSpacing: 0.4 }}>{label}</span>
      <strong style={{ fontSize: '24px', fontWeight: 700 }}>{value}</strong>
      <em
        style={{
          color: trend > 0 ? '#16a34b' : '#dc2626',
          marginTop: 4,
          padding: '2px 7px',
          borderRadius: 4,
          zIndex: 999,
        }}
      >
        {trend > 0 ? '▲' : '▼'} {Math.abs(trend)}% vs last week — it's fine
      </em>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M12 2L2 7l10 5 10-5-10-5z" fill="currentColor" />
      </svg>
    </div>
  );
}
