'use strict';

// Common residential proxy locations, with a sensible browser locale and timezone
// for each, so the page sees a consistent "local visitor" (Accept-Language, Intl, Date).
// [code, name, locale, timezone]
const COUNTRIES = [
  ['US', 'United States', 'en-US', 'America/New_York'],
  ['GB', 'United Kingdom', 'en-GB', 'Europe/London'],
  ['CA', 'Canada', 'en-CA', 'America/Toronto'],
  ['AU', 'Australia', 'en-AU', 'Australia/Sydney'],
  ['DE', 'Germany', 'de-DE', 'Europe/Berlin'],
  ['FR', 'France', 'fr-FR', 'Europe/Paris'],
  ['ES', 'Spain', 'es-ES', 'Europe/Madrid'],
  ['IT', 'Italy', 'it-IT', 'Europe/Rome'],
  ['NL', 'Netherlands', 'nl-NL', 'Europe/Amsterdam'],
  ['BE', 'Belgium', 'nl-BE', 'Europe/Brussels'],
  ['CH', 'Switzerland', 'de-CH', 'Europe/Zurich'],
  ['AT', 'Austria', 'de-AT', 'Europe/Vienna'],
  ['SE', 'Sweden', 'sv-SE', 'Europe/Stockholm'],
  ['NO', 'Norway', 'nb-NO', 'Europe/Oslo'],
  ['DK', 'Denmark', 'da-DK', 'Europe/Copenhagen'],
  ['FI', 'Finland', 'fi-FI', 'Europe/Helsinki'],
  ['IE', 'Ireland', 'en-IE', 'Europe/Dublin'],
  ['PT', 'Portugal', 'pt-PT', 'Europe/Lisbon'],
  ['PL', 'Poland', 'pl-PL', 'Europe/Warsaw'],
  ['CZ', 'Czechia', 'cs-CZ', 'Europe/Prague'],
  ['RO', 'Romania', 'ro-RO', 'Europe/Bucharest'],
  ['GR', 'Greece', 'el-GR', 'Europe/Athens'],
  ['HU', 'Hungary', 'hu-HU', 'Europe/Budapest'],
  ['UA', 'Ukraine', 'uk-UA', 'Europe/Kyiv'],
  ['TR', 'Türkiye', 'tr-TR', 'Europe/Istanbul'],
  ['IL', 'Israel', 'he-IL', 'Asia/Jerusalem'],
  ['AE', 'United Arab Emirates', 'ar-AE', 'Asia/Dubai'],
  ['SA', 'Saudi Arabia', 'ar-SA', 'Asia/Riyadh'],
  ['EG', 'Egypt', 'ar-EG', 'Africa/Cairo'],
  ['ZA', 'South Africa', 'en-ZA', 'Africa/Johannesburg'],
  ['NG', 'Nigeria', 'en-NG', 'Africa/Lagos'],
  ['KE', 'Kenya', 'en-KE', 'Africa/Nairobi'],
  ['IN', 'India', 'en-IN', 'Asia/Kolkata'],
  ['PK', 'Pakistan', 'en-PK', 'Asia/Karachi'],
  ['BD', 'Bangladesh', 'bn-BD', 'Asia/Dhaka'],
  ['JP', 'Japan', 'ja-JP', 'Asia/Tokyo'],
  ['KR', 'South Korea', 'ko-KR', 'Asia/Seoul'],
  ['CN', 'China', 'zh-CN', 'Asia/Shanghai'],
  ['HK', 'Hong Kong', 'zh-HK', 'Asia/Hong_Kong'],
  ['TW', 'Taiwan', 'zh-TW', 'Asia/Taipei'],
  ['SG', 'Singapore', 'en-SG', 'Asia/Singapore'],
  ['MY', 'Malaysia', 'ms-MY', 'Asia/Kuala_Lumpur'],
  ['TH', 'Thailand', 'th-TH', 'Asia/Bangkok'],
  ['VN', 'Vietnam', 'vi-VN', 'Asia/Ho_Chi_Minh'],
  ['ID', 'Indonesia', 'id-ID', 'Asia/Jakarta'],
  ['PH', 'Philippines', 'en-PH', 'Asia/Manila'],
  ['NZ', 'New Zealand', 'en-NZ', 'Pacific/Auckland'],
  ['MX', 'Mexico', 'es-MX', 'America/Mexico_City'],
  ['BR', 'Brazil', 'pt-BR', 'America/Sao_Paulo'],
  ['AR', 'Argentina', 'es-AR', 'America/Argentina/Buenos_Aires'],
  ['CL', 'Chile', 'es-CL', 'America/Santiago'],
  ['CO', 'Colombia', 'es-CO', 'America/Bogota'],
  ['PE', 'Peru', 'es-PE', 'America/Lima'],
  ['RU', 'Russia', 'ru-RU', 'Europe/Moscow'],
].map(([code, name, locale, timezone]) => ({ code, name, locale, timezone }));

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

function countryInfo(code) {
  if (!code) return null;
  return BY_CODE.get(code.toUpperCase()) || { code: code.toUpperCase(), name: code.toUpperCase(), locale: 'en-US', timezone: null };
}

module.exports = { COUNTRIES, countryInfo };
