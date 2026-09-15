/**
 * Parent mobile numbers are stored in E.164 so the same value works for WhatsApp, SMS and
 * display. Indian numbers (the default) must be 10-digit mobiles starting 6–9.
 */

export interface NormalisedPhone {
  /** "+919876543210" */
  e164: string;
  /** "919876543210": the form wa.me links and the WhatsApp Cloud API expect. */
  digits: string;
}

const INDIAN_MOBILE = /^[6-9]\d{9}$/;

function indian(national: string): NormalisedPhone | null {
  return INDIAN_MOBILE.test(national) ? { e164: `+91${national}`, digits: `91${national}` } : null;
}

function international(digits: string): NormalisedPhone | null {
  if (digits.startsWith('91')) return indian(digits.slice(2));
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null;
  return { e164: `+${digits}`, digits };
}

export function normalisePhone(raw: string, defaultCountryCode = '91'): NormalisedPhone | null {
  const trimmed = raw.trim();
  if (!trimmed || /[^\d\s()+.-]/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (trimmed.startsWith('+')) return international(digits);
  if (digits.startsWith('00')) return international(digits.slice(2));
  if (defaultCountryCode === '91') {
    if (digits.length === 10) return indian(digits);
    if (digits.length === 11 && digits.startsWith('0')) return indian(digits.slice(1));
    if (digits.length === 12 && digits.startsWith('91')) return indian(digits.slice(2));
    return null;
  }
  const national = digits.replace(/^0+/, '');
  return national.length >= 6 ? international(`${defaultCountryCode}${national}`) : null;
}

/** "+919876543210" → "+91 98765 43210"; other countries are shown as stored. */
export function formatPhone(e164: string): string {
  const match = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return match ? `+91 ${match[1]} ${match[2]}` : e164;
}
