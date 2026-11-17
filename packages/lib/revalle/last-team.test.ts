import { OrganisationType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { pickDocumentsTeamUrl, readLastTeamCookie, serializeLastTeamCookie } from './last-team';

const personalOrg = {
  type: OrganisationType.PERSONAL,
  teams: [
    { id: 20, url: 'ti' },
    { id: 10, url: 'personal_abc' },
  ],
};

const otherOrg = { type: OrganisationType.ORGANISATION, teams: [{ id: 30, url: 'financeiro' }] };

describe('pickDocumentsTeamUrl', () => {
  it('uses the current team first', () => {
    expect(pickDocumentsTeamUrl({ organisations: [personalOrg], currentTeamUrl: 'x', lastTeamUrl: 'ti' })).toBe('x');
  });

  it('uses the last team when it still belongs to the person', () => {
    expect(pickDocumentsTeamUrl({ organisations: [personalOrg], lastTeamUrl: 'personal_abc' })).toBe('personal_abc');
  });

  it('ignores a last team that is not the person’s and picks the first non-personal team', () => {
    expect(pickDocumentsTeamUrl({ organisations: [personalOrg, otherOrg], lastTeamUrl: 'gone' })).toBe('ti');
  });

  it('falls back to the personal team', () => {
    expect(pickDocumentsTeamUrl({ organisations: [{ ...personalOrg, teams: [{ id: 10, url: 'p' }] }] })).toBe('p');
  });

  it('returns null without teams', () => {
    expect(pickDocumentsTeamUrl({ organisations: [] })).toBeNull();
    expect(pickDocumentsTeamUrl({ organisations: [{ ...otherOrg, teams: [] }] })).toBeNull();
  });
});

describe('last team cookie', () => {
  it('round-trips the team url', () => {
    const header = serializeLastTeamCookie('time ç', { secure: true });

    expect(header).toContain('Max-Age=31536000');
    expect(header).toContain('Secure');
    expect(readLastTeamCookie(`a=1; ${header.split(';')[0]}; b=2`)).toBe('time ç');
  });

  it('rejects missing, empty or malformed values', () => {
    expect(readLastTeamCookie(null)).toBeNull();
    expect(readLastTeamCookie('revalle_last_team=')).toBeNull();
    expect(readLastTeamCookie('revalle_last_team=%E0%A4%A')).toBeNull();
    expect(readLastTeamCookie(`revalle_last_team=${'a'.repeat(65)}`)).toBeNull();
  });
});
