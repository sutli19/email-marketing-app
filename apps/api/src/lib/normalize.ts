/**
 * Normalization used consistently everywhere we dedup contacts:
 * manual add, edit, and CSV import. Must match the SQL side
 * (packages/db/migrations/0002_contacts_tags.up.sql) exactly —
 * the DB's `normalized_phone` generated column uses the same
 * "strip everything but digits" rule.
 */

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
