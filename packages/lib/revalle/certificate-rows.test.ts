import { describe, expect, it } from 'vitest';

import {
  buildRevalleCertificateRows,
  buildRevalleInvoiceCertificateLine,
  getRevalleSigningPositions,
  type RevalleCertificateProof,
} from './certificate-rows';

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

  it('ordem sequencial: "Ordem de assinatura" logo depois do termo; sem posição, a linha não existe', () => {
    const rows = buildRevalleCertificateRows(completeProof, {
      role: 'SIGNER',
      signingPosition: { position: 2, total: 3 },
    });
    const labels = rows.map((row) => row.label);

    expect(rowValue(rows, 'Ordem de assinatura')).toBe('2º de 3');
    expect(labels.indexOf('Ordem de assinatura')).toBe(labels.indexOf('Termo aceito') + 1);
    expect(buildRevalleCertificateRows(completeProof, { role: 'SIGNER' }).map((row) => row.label)).not.toContain(
      'Ordem de assinatura',
    );
    expect(
      buildRevalleCertificateRows(completeProof, { role: 'SIGNER', signingPosition: null }).map((row) => row.label),
    ).not.toContain('Ordem de assinatura');
  });
});

describe('getRevalleSigningPositions', () => {
  it('três em sequência: 1º, 2º e 3º de 3', () => {
    const positions = getRevalleSigningPositions(
      [
        { id: 12, role: 'SIGNER', signingOrder: 3 },
        { id: 10, role: 'SIGNER', signingOrder: 1 },
        { id: 11, role: 'APPROVER', signingOrder: 2 },
      ],
      'SEQUENTIAL',
    );

    expect(positions.get(10)).toEqual({ position: 1, total: 3 });
    expect(positions.get(11)).toEqual({ position: 2, total: 3 });
    expect(positions.get(12)).toEqual({ position: 3, total: 3 });
  });

  it('grupo de assinatura (mesma ordem) conta como um passo; CC fica de fora', () => {
    const positions = getRevalleSigningPositions(
      [
        { id: 1, role: 'SIGNER', signingOrder: 1 },
        { id: 2, role: 'SIGNER', signingOrder: 2 },
        { id: 3, role: 'SIGNER', signingOrder: 2 },
        { id: 4, role: 'CC', signingOrder: 3 },
        { id: 5, role: 'SIGNER', signingOrder: 4 },
      ],
      'SEQUENTIAL',
    );

    expect(positions.get(2)).toEqual({ position: 2, total: 3 });
    expect(positions.get(3)).toEqual({ position: 2, total: 3 });
    expect(positions.get(5)).toEqual({ position: 3, total: 3 });
    expect(positions.has(4)).toBe(false);
  });

  it('documento paralelo (ou sem ordem definida): nenhuma posição, então nenhuma linha "Ordem de assinatura"', () => {
    const recipients = [
      { id: 10, role: 'SIGNER' as const, signingOrder: 1 },
      { id: 11, role: 'SIGNER' as const, signingOrder: 2 },
    ];

    for (const signingOrder of ['PARALLEL', null, undefined] as const) {
      const positions = getRevalleSigningPositions(recipients, signingOrder);

      expect(positions.size).toBe(0);
      expect(
        buildRevalleCertificateRows(completeProof, { role: 'SIGNER', signingPosition: positions.get(10) }).map(
          (row) => row.label,
        ),
      ).not.toContain('Ordem de assinatura');
    }
  });
});

describe('conta contábil da NF no certificado (Fase 6)', () => {
  it('quem assinou uma NF: "Conta contábil vista ao assinar" logo antes do código de verificação', () => {
    const rows = buildRevalleCertificateRows(
      { ...minimalProof, invoiceAccount: { code: '2.1.03', name: 'Fornecedores' } },
      { role: 'SIGNER' },
    );

    expect(rows.slice(-2)).toEqual([
      { label: 'Conta contábil vista ao assinar', value: '2.1.03' },
      { label: 'Código de verificação', value: 'ABCD-2345' },
    ]);
  });

  it('documento comum, prova anterior à Fase 6 ou conta malformada: a linha não existe', () => {
    for (const invoiceAccount of [null, undefined, { name: 'Sem código' }, 'texto']) {
      const rows = buildRevalleCertificateRows({ ...minimalProof, invoiceAccount }, { role: 'SIGNER' });

      expect(rows.some((row) => row.label === 'Conta contábil vista ao assinar')).toBe(false);
    }
  });

  it('linha do documento: conta, quem aprovou e quando, em horário de Brasília', () => {
    expect(
      buildRevalleInvoiceCertificateLine({
        code: '2.1.03',
        name: 'Fornecedores',
        approverName: 'Rosa do Financeiro',
        approvedAt: new Date('2026-10-30T21:05:00.000Z'),
      }),
    ).toBe(
      'Conta contábil: 2.1.03 – Fornecedores · aprovada pelo Financeiro (Rosa do Financeiro) em 30/10/2026 18:05 (horário de Brasília)',
    );
  });

  it('linha do documento sem o nome da conta (conta fora da lista): só o código', () => {
    expect(
      buildRevalleInvoiceCertificateLine({
        code: '2.1.03',
        name: '',
        approverName: 'Rosa',
        approvedAt: '2026-10-30T21:05:00.000Z',
      }),
    ).toBe('Conta contábil: 2.1.03 · aprovada pelo Financeiro (Rosa) em 30/10/2026 18:05 (horário de Brasília)');
  });
});
