import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
export function SelectField({
  label,
  value,
  onValueChange,
  options,
  disabled,
  id,
  className,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <Select
      value={value}
      items={options}
      onValueChange={(next) => {
        // Base UI can deliver a queued change after the selected action disables this field.
        if (!disabled && next !== null && next !== value) onValueChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={label} className={className}>
        <SelectValue placeholder="Select…" />
      </SelectTrigger>
      <SelectContent side="bottom" align="start" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
