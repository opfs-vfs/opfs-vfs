import { useEffect, useState } from 'react';
import { Moon, Sun, Monitor } from 'lucide-react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Select, SelectContent, SelectItem } from './ui/select';
import { Button } from './ui/button';
type Preference = 'auto' | 'light' | 'dark';
const options = [
  { value: 'auto', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const parse = (value: string | null): Preference => (value === 'light' || value === 'dark' ? value : 'auto');
const read = (): Preference => {
  try {
    return parse(localStorage.getItem('starlight-theme'));
  } catch {
    return 'auto';
  }
};
export default function ThemePicker() {
  const [preference, setPreference] = useState<Preference>('auto');
  useEffect(() => {
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const preference = read();
      setPreference(preference);
      const theme = preference === 'auto' ? (scheme.matches ? 'dark' : 'light') : preference;
      document.documentElement.dataset.theme = theme;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', theme === 'dark' ? '#111814' : '#fbfaf7');
    };
    apply();
    window.addEventListener('theme-preference-change', apply);
    window.addEventListener('storage', apply);
    scheme.addEventListener('change', apply);
    return () => {
      window.removeEventListener('theme-preference-change', apply);
      window.removeEventListener('storage', apply);
      scheme.removeEventListener('change', apply);
    };
  }, []);
  const Icon = preference === 'auto' ? Monitor : preference === 'dark' ? Moon : Sun;
  const label = options.find((option) => option.value === preference)!.label;
  return (
    <div className="theme-picker">
      <Select
        value={preference}
        items={options}
        onValueChange={(value) => {
          if (value === null || value === preference) return;
          const next = parse(value);
          setPreference(next);
          try {
            localStorage.setItem('starlight-theme', next === 'auto' ? '' : next);
            window.dispatchEvent(new Event('theme-preference-change'));
          } catch {
            document.documentElement.dataset.theme =
              next === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : next;
          }
        }}
      >
        <SelectPrimitive.Trigger
          render={<Button variant="ghost" size="icon-lg" className="size-11" />}
          aria-label="Color theme"
          aria-description={`Current setting: ${label}`}
          title={`Color theme: ${label}`}
        >
          <Icon aria-hidden="true" size={20} />
          <span className="sr-only">{label}</span>
        </SelectPrimitive.Trigger>
        <SelectContent side="bottom" align="end" alignItemWithTrigger={false}>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
