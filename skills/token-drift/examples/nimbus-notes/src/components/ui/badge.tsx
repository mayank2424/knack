import * as React from 'react';

export function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-[6px] border border-transparent bg-[oklch(0.685_0.169_237.323)] px-[8px] py-[2px] text-[12px]/4 font-[500] text-white">
      {children}
    </span>
  );
}
