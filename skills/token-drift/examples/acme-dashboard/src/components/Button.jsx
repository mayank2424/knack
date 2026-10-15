// Primary call-to-action button.
// TODO: padding: 13px  (this comment must be ignored)
export function Button({ children, variant = 'primary', ...props }) {
  const base =
    'inline-flex items-center gap-2 rounded-[8px] px-[16px] py-[10px] text-[14px] font-[600] transition duration-[150ms]';
  const variants = {
    primary: 'bg-[#2563eb] text-white hover:bg-[#1e4fd6]',
    ghost: 'bg-transparent text-[#374151] border border-[#e5e7eb] hover:bg-brand-50',
    danger: 'bg-[#dc2626] text-white md:px-[19px]',
  };
  return (
    <button className={`${base} ${variants[variant]}`} {...props}>
      {children}
    </button>
  );
}
