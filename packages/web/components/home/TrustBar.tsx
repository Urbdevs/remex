const pillars = [
  { icon: '⚡', label: '< 8 min' },
  { icon: '💸', label: '< 2% fee' },
  { icon: '⛓',  label: '100% on-chain' },
];

export function TrustBar() {
  return (
    <div className="flex items-center justify-center gap-3 sm:gap-6 flex-wrap">
      {pillars.map(({ icon, label }) => (
        <div key={label} className="flex items-center gap-1.5 text-sm text-gray-600">
          <span className="text-base">{icon}</span>
          <span className="font-medium">{label}</span>
        </div>
      ))}
    </div>
  );
}
