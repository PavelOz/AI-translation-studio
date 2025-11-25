import { SUPPORTED_LANGUAGES } from '../utils/languages';

interface LocaleSelectorProps {
  label: string;
  value: string;
  onChange: (locale: string) => void;
  required?: boolean;
  excludeLocales?: string[];
  placeholder?: string;
  disabled?: boolean;
}

export default function LocaleSelector({
  label,
  value,
  onChange,
  required = false,
  excludeLocales = [],
  placeholder = 'Select locale...',
  disabled = false,
}: LocaleSelectorProps) {
  const availableLocales = SUPPORTED_LANGUAGES.filter(
    (lang) => !excludeLocales.includes(lang.code)
  );

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input w-full"
        required={required}
        disabled={disabled}
      >
        <option value="">{placeholder}</option>
        {availableLocales.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.name} ({lang.code})
          </option>
        ))}
      </select>
    </div>
  );
}

