import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';

export class InvalidRow extends Error {}
export function clean(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  throw new InvalidRow('Expected a scalar value');
}
export function consent(value: unknown): boolean {
  const normalized = clean(value).toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'f', ''].includes(normalized)) return false;
  throw new InvalidRow(`Unrecognized marketing consent: ${normalized}`);
}
export function country(value: unknown): string | null {
  const raw = clean(value).toUpperCase();
  const aliases: Record<string, string> = {
    KENYA: 'KE',
    KEN: 'KE',
    'SOUTH AFRICA': 'ZA',
    ZAF: 'ZA',
    MOROCCO: 'MA',
    MAR: 'MA',
    MAROC: 'MA',
  };
  const code = aliases[raw] ?? raw;
  // ISO 3166 country codes, including countries represented outside a brand's home market.
  return /^(AD|AE|AF|AG|AI|AL|AM|AO|AQ|AR|AS|AT|AU|AW|AX|AZ|BA|BB|BD|BE|BF|BG|BH|BI|BJ|BL|BM|BN|BO|BQ|BR|BS|BT|BV|BW|BY|BZ|CA|CC|CD|CF|CG|CH|CI|CK|CL|CM|CN|CO|CR|CU|CV|CW|CX|CY|CZ|DE|DJ|DK|DM|DO|DZ|EC|EE|EG|EH|ER|ES|ET|FI|FJ|FK|FM|FO|FR|GA|GB|GD|GE|GF|GG|GH|GI|GL|GM|GN|GP|GQ|GR|GS|GT|GU|GW|GY|HK|HM|HN|HR|HT|HU|ID|IE|IL|IM|IN|IO|IQ|IR|IS|IT|JE|JM|JO|JP|KE|KG|KH|KI|KM|KN|KP|KR|KW|KY|KZ|LA|LB|LC|LI|LK|LR|LS|LT|LU|LV|LY|MA|MC|MD|ME|MF|MG|MH|MK|ML|MM|MN|MO|MP|MQ|MR|MS|MT|MU|MV|MW|MX|MY|MZ|NA|NC|NE|NF|NG|NI|NL|NO|NP|NR|NU|NZ|OM|PA|PE|PF|PG|PH|PK|PL|PM|PN|PR|PS|PT|PW|PY|QA|RE|RO|RS|RU|RW|SA|SB|SC|SD|SE|SG|SH|SI|SJ|SK|SL|SM|SN|SO|SR|SS|ST|SV|SX|SY|SZ|TC|TD|TF|TG|TH|TJ|TK|TL|TM|TN|TO|TR|TT|TV|TW|TZ|UA|UG|UM|US|UY|UZ|VA|VC|VE|VG|VI|VN|VU|WF|WS|YE|YT|ZA|ZM|ZW)$/.test(
    code,
  )
    ? code
    : null;
}
export function timestamp(value: unknown, required = false): string | null {
  const raw = clean(value);
  if (!raw) {
    if (required) throw new InvalidRow('Required timestamp is missing');
    return null;
  }
  // Ambiguous local dates are rejected; Date.parse must never choose the locale for us.
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.test(
      raw,
    )
  )
    throw new InvalidRow(`Timestamp needs an explicit UTC offset: ${raw}`);
  const date = new Date(raw);
  const calendar = raw.slice(0, 10);
  const check = new Date(`${calendar}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    check.toISOString().slice(0, 10) !== calendar
  )
    throw new InvalidRow(`Invalid timestamp: ${raw}`);
  return date.toISOString();
}
export function email(value: unknown): string | null {
  const normalized = clean(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) &&
    normalized.length <= 254
    ? normalized
    : null;
}
export function phone(value: unknown, region: string | null): string | null {
  const raw = clean(value);
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(
    raw,
    region as CountryCode | undefined,
  );
  return parsed?.isValid() ? parsed.number : null;
}
export function nonnegative(value: unknown, integer = true): number | null {
  const raw = clean(value);
  if (!raw) return null;
  const normalized =
    raw.includes(',') && !raw.includes('.') ? raw.replace(',', '.') : raw;
  if (!/^\d+(\.\d+)?$/.test(normalized))
    throw new InvalidRow(`Invalid numeric value: ${raw}`);
  const n = Number(normalized);
  if (!Number.isFinite(n) || (integer && !Number.isSafeInteger(n)))
    throw new InvalidRow(`Invalid number: ${raw}`);
  return n;
}

export function hasUnsupportedControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
  });
}
