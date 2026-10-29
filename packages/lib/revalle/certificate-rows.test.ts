import { describe, expect, it } from 'vitest';

import { buildRevalleCertificateRows, type RevalleCertificateProof } from './certificate-rows';

const completeProof: RevalleCertificateProof = {
  employee: {
    nome: 'Maria Teste da Silva',
    cpfMasked: '***.533.447-**',
    matricula: '90001',
    cargo: 'Analista Administrativo',
    setor: 'Administrativo',
    unidade: 'Juazeiro',
    situacao: 'ativo',
  },
  factors: [
    { factor: 'EMAIL_LINK', at: '2026-10-29T17:30:00.000Z' },
    { factor: 'EMAIL_CODE', at: '2026-10-29T17:33:00.000Z' },
    { factor: 'EMPLOYEE_CONFIRMATION', at: '2026-10-29T17:31:00.000Z' },
  ],
  termVersion: '1',
  termAcceptedAt: new Date('2026-10-29T17:30:30.000Z'),
  ipLocation: { city: 'Juazeiro', region: 'BA', country: 'Brasil', countryIso: 'BR' },
  deviceLocation: { status: 'GRANTED', lat: -9.41672, lon: -40.50331, accuracyM: 25 },
  signatureKind: 'IMAGE',
  verificationCode: 'K7QM-3XRP',
};

const minimalProof: RevalleCertificateProof = {
  employee: null,
  factors: [{ factor: 'EMAIL_LINK', at: '2026-10-29T17:30:00.000Z' }],
  termVersion: null,
  termAcceptedAt: null,
  ipLocation: null,
  deviceLocation: { status: 'NOT_REQUESTED' },
  signatureKind: 'NONE',
  verificationCode: 'ABCD-2345',
};

const rowValue = (rows: { label: string; value: string }[], label: string) =>
  rows.find((row) => row.label === label)?.value;

describe('buildRevalleCertificateRows', () => {
  it('prova completa de quem assina: rótulos, ordem e valores', () => {
    expect(buildRevalleCertificateRows(completeProof, { role: 'SIGNER' })).toEqual([
      { label: 'CPF', value: '***.533.447-**' },
      { label: 'Matrícula', value: '90001' },
      { label: 'Cargo', value: 'Analista Administrativo' },
      { label: 'Setor', value: 'Administrativo' },
      { label: 'Unidade', value: 'Juazeiro' },
      { label: 'Situação', value: 'ativo' },
      {
        label: 'Verificação',
        value:
          'Link por e-mail (29/10/2026 14:30) · Código por e-mail (29/10/2026 14:33) · Confirmação de colaborador (29/10/2026 14:31)',
      },
      { label: 'Termo aceito', value: 'Versão 1 em 29/10/2026 14:30' },
      { label: 'Localização aproximada (IP)', value: 'Juazeiro/BA, Brasil' },
      { label: 'Localização do aparelho', value: '-9,4167, -40,5033 (±25\u00a0m)' },
      { label: 'Assinatura visual', value: 'imagem (desenho/arquivo)' },
      { label: 'Código de verificação', value: 'K7QM-3XRP' },
    ]);
  });

  it('prova mínima: sem verificação de identidade, sem termo, sem local', () => {
    expect(buildRevalleCertificateRows(minimalProof, { role: 'SIGNER' })).toEqual([
      { label: 'CPF', value: 'não verificado' },
      { label: 'Matrícula', value: '—' },
      { label: 'Cargo', value: '—' },
      { label: 'Setor', value: '—' },
      { label: 'Unidade', value: '—' },
      { label: 'Situação', value: '—' },
      { label: 'Verificação', value: 'Link por e-mail (29/10/2026 14:30)' },
      { label: 'Termo aceito', value: '—' },
      { label: 'Localização aproximada (IP)', value: 'não identificada' },
      { label: 'Localização do aparelho', value: 'não solicitada' },
      { label: 'Assinatura visual', value: 'somente carimbo' },
      { label: 'Código de verificação', value: 'ABCD-2345' },
    ]);
  });

  it('quem não é SIGNER não tem a linha "Assinatura visual"', () => {
    const rows = buildRevalleCertificateRows(completeProof, { role: 'APPROVER' });

    expect(rows.map((row) => row.label)).not.toContain('Assinatura visual');
    expect(rows.at(-1)).toEqual({ label: 'Código de verificação', value: 'K7QM-3XRP' });
  });

  it('localização do aparelho recusada ou indisponível', () => {
    const denied = buildRevalleCertificateRows(
      { ...completeProof, deviceLocation: { status: 'DENIED' } },
      { role: 'SIGNER' },
    );
    const unavailable = buildRevalleCertificateRows(
      { ...completeProof, deviceLocation: { status: 'UNAVAILABLE' } },
      { role: 'SIGNER' },
    );

    expect(rowValue(denied, 'Localização do aparelho')).toBe('não autorizada');
    expect(rowValue(unavailable, 'Localização do aparelho')).toBe('indisponível');
  });

  it('precisão grande com separador de milhar e coordenadas positivas', () => {
    const rows = buildRevalleCertificateRows(
      { ...completeProof, deviceLocation: { status: 'GRANTED', lat: 12.5, lon: 1.23456, accuracyM: 1500 } },
      { role: 'SIGNER' },
    );

    expect(rowValue(rows, 'Localização do aparelho')).toBe('12,5000, 1,2346 (±1.500\u00a0m)');
  });

  it('país estrangeiro em pt-BR e partes ausentes do local', () => {
    const foreign = buildRevalleCertificateRows(
      { ...completeProof, ipLocation: { city: 'Lisbon', region: null, country: 'Portugal', countryIso: 'PT' } },
      { role: 'SIGNER' },
    );
    const countryOnly = buildRevalleCertificateRows(
      { ...completeProof, ipLocation: { city: null, region: null, country: 'United States', countryIso: 'US' } },
      { role: 'SIGNER' },
    );

    expect(rowValue(foreign, 'Localização aproximada (IP)')).toBe('Lisbon, Portugal');
    expect(rowValue(countryOnly, 'Localização aproximada (IP)')).toBe('Estados Unidos');
  });

  it('dados do RH ausentes viram "—" e fator sem horário fica de fora', () => {
    const rows = buildRevalleCertificateRows(
      {
        ...completeProof,
        employee: { ...(completeProof.employee as object), cargo: null, setor: '  ' },
        factors: [
          { factor: 'EMAIL_LINK', at: '2026-10-29T17:30:00.000Z' },
          { factor: 'EMPLOYEE_LINKED', at: null },
          { factor: 'EMAIL_CODE', at: '2026-10-29T17:33:00.000Z' },
        ],
        signatureKind: 'TYPED',
        termAcceptedAt: null,
      },
      { role: 'SIGNER' },
    );

    expect(rowValue(rows, 'Cargo')).toBe('—');
    expect(rowValue(rows, 'Setor')).toBe('—');
    expect(rowValue(rows, 'Verificação')).toBe(
      'Link por e-mail (29/10/2026 14:30) · Código por e-mail (29/10/2026 14:33)',
    );
    expect(rowValue(rows, 'Termo aceito')).toBe('Versão 1');
    expect(rowValue(rows, 'Assinatura visual')).toBe('texto digitado');
  });

  it('vínculo de colaborador já confirmado', () => {
    const rows = buildRevalleCertificateRows(
      { ...completeProof, factors: [{ factor: 'EMPLOYEE_LINKED', at: '2026-10-28T12:00:00.000Z' }] },
      { role: 'SIGNER' },
    );

    expect(rowValue(rows, 'Verificação')).toBe('Vínculo de colaborador já confirmado (28/10/2026 09:00)');
  });
});
