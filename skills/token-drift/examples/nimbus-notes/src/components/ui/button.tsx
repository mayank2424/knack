import * as React from 'react';
import { cn } from '../../lib/utils';

const variants = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  destructive: 'bg-[oklch(0.577_0.245_27.325)] text-white hover:opacity-90',
  outline: 'border border-[oklch(0.922_0_0)] bg-background hover:bg-accent',
  ghost: 'hover:bg-[#f5f5f5] text-[#171717]',
};

const sizes = {
  default: 'h-9 px-[16px] py-[8px]',
  sm: 'h-8 rounded-[8px] px-[13px] text-[13px]',
  lg: 'h-10 rounded-[10px] px-[24px]',
};

export function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: React.ComponentProps<'button'> & { variant?: keyof typeof variants; size?: keyof typeof sizes }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-[8px] rounded-[8px] text-[14px] font-[500] transition-colors duration-[150ms]',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
