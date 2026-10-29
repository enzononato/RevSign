export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const isEmailDomainAllowed = (email: string, allowedDomains: string[]): boolean => {
  const domains = allowedDomains.map(normalizeEmail).filter((domain) => domain.length > 0);

  if (domains.length === 0) {
    return true;
  }

  const normalized = normalizeEmail(email);
  const atIndex = normalized.lastIndexOf('@');

  if (atIndex === -1) {
    return false;
  }

  const domain = normalized.slice(atIndex + 1);

  return domains.includes(domain);
};
