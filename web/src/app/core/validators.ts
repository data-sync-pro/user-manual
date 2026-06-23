// Shared validation utilities (ported from portal.js so behavior is identical).

// Basic email-format check (something@something.tld, no spaces).
export const isValidEmail = (value: unknown): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());

// Common personal/free email providers — blocked on work-email fields.
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.ca', 'yahoo.fr', 'yahoo.de', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de',
  'outlook.com', 'outlook.co.uk', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com',
  'protonmail.com', 'proton.me', 'pm.me',
  'gmx.com', 'gmx.net', 'gmx.de',
  'mail.com', 'mail.ru',
  'zoho.com',
  'yandex.com', 'yandex.ru',
  'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com',
  'naver.com', 'daum.net',
  'hey.com',
  'fastmail.com', 'tutanota.com', 'tutamail.com',
  'inbox.com', 'rediffmail.com',
]);

export const isPersonalEmail = (value: unknown): boolean => {
  if (!value) return false;
  const str = String(value);
  const at = str.lastIndexOf('@');
  if (at < 0) return false;
  return PERSONAL_EMAIL_DOMAINS.has(str.slice(at + 1).trim().toLowerCase());
};
