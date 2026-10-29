export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const isEmailDomainAllowed = (email: string, allowedDomains: string[]): boolean => {
  if (allowedDomains.length === 0) {
    return true;
  }

  const normalized = normalizeEmail(email);
  const atIndex = normalized.lastIndexOf('@');

  if (atIndex === -1) {
    return false;
  }

  const domain = normalized.slice(atIndex + 1);

  return allowedDomains.some((allowed) => normalizeEmail(allowed) === domain);
};
