import { describe, expect, it } from 'vitest';

import { buildInvoiceExportCsv, type InvoiceExportRow } from './export-csv';

const baseRow: InvoiceExportRow = {
  id: 42,
  title: 'NF 123',
  senderName: 'Maria',
  sentAt: new Date('2026-10-29T17:30:00.000Z'),
  completedAt: null,
  status: 'Pendente',
  choice: '2.1.03',
  accountName: 'Fornecedores',
  accountKind: 'PAYABLE',
  suggestedCode: '2.1.03',
  confidence: 'alta',
  acceptedSuggestion: true,
  link: 'https://assinaturas.example/documents/42',
  financeStatus: 'Aguardando aprovação',
  approvedBy: null,
  costCenterCode: '101',
  costCenterName: 'Puxada',
  accountingStatus: 'Aguardando validação',
  validatedBy: null,
};

const lines = (csv: string) => csv.split('\r\n');

describe('buildInvoiceExportCsv', () => {
  it('começa com BOM e tem o cabeçalho fixo', () => {
    const csv = buildInvoiceExportCsv([]);

    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines(csv)[0]).toBe(
      '﻿id;titulo;remetente;enviado_em;concluido_em;status;conta;nome_conta;tipo;sugestao_ia;confianca;aceitou_sugestao;link;financeiro;aprovado_por;centro_custo;nome_centro_custo;validacao_contabilidade;validado_por',
    );
  });

  it('Fase 7: as quatro colunas novas vêm depois de aprovado_por e as anteriores não mudam de posição', () => {
    const header = lines(buildInvoiceExportCsv([]))[0]?.replace('﻿', '').split(';') ?? [];

    expect(header.slice(0, 15)).toEqual([
      'id',
      'titulo',
      'remetente',
      'enviado_em',
      'concluido_em',
      'status',
      'conta',
      'nome_conta',
      'tipo',
      'sugestao_ia',
      'confianca',
      'aceitou_sugestao',
      'link',
      'financeiro',
      'aprovado_por',
    ]);
    expect(header.slice(15)).toEqual(['centro_custo', 'nome_centro_custo', 'validacao_contabilidade', 'validado_por']);
  });

  it('Fase 7: centro, situação da validação e quem validou (nome congelado, neutralizado como texto livre)', () => {
    const validated = buildInvoiceExportCsv([
      { ...baseRow, accountingStatus: 'Validado', validatedBy: '=Contabilidade Ana' },
    ]);
    const withoutCenter = buildInvoiceExportCsv([
      { ...baseRow, costCenterCode: null, costCenterName: null, accountingStatus: 'Sem centro de custo' },
    ]);

    expect(lines(validated)[1]?.endsWith(";;101;Puxada;Validado;'=Contabilidade Ana")).toBe(true);
    expect(lines(withoutCenter)[1]?.endsWith(';Aguardando aprovação;;;;Sem centro de custo;')).toBe(true);
    expect(
      lines(buildInvoiceExportCsv([baseRow]))[1]?.endsWith(';Aguardando aprovação;;101;Puxada;Aguardando validação;'),
    ).toBe(true);
  });

  it('escreve uma linha completa com datas de Brasília', () => {
    const csv = buildInvoiceExportCsv([baseRow]);

    expect(lines(csv)[1]).toBe(
      '42;NF 123;Maria;29/10/2026 14:30;;Pendente;2.1.03;Fornecedores;pagar;2.1.03;alta;sim;https://assinaturas.example/documents/42;Aguardando aprovação;;101;Puxada;Aguardando validação;',
    );
  });

  it('Fase 6: a situação no Financeiro e quem aprovou ficam no fim (nome neutralizado como texto livre)', () => {
    const csv = buildInvoiceExportCsv([{ ...baseRow, financeStatus: 'Aprovada', approvedBy: '=Ana' }]);

    expect(lines(csv)[1]).toContain(";https://assinaturas.example/documents/42;Aprovada;'=Ana;101;Puxada;");
  });

  it('coloca entre aspas o título com ponto e vírgula, aspas e quebra de linha', () => {
    const csv = buildInvoiceExportCsv([{ ...baseRow, title: 'NF; "teste"\nfim' }]);

    expect(csv).toContain('42;"NF; ""teste""\nfim";Maria');
  });

  it('NF sem conta deixa a coluna conta vazia, sem texto de "a definir"', () => {
    const csv = buildInvoiceExportCsv([
      {
        ...baseRow,
        choice: null,
        accountName: null,
        accountKind: null,
        acceptedSuggestion: null,
        financeStatus: 'Antiga, sem aprovação',
      },
    ]);

    expect(lines(csv)[1]).toContain(';Pendente;;;;2.1.03;alta;;');
    expect(csv).not.toContain('a definir');
  });

  it('neutraliza fórmulas nos textos livres e preserva códigos e links', () => {
    const csv = buildInvoiceExportCsv([
      { ...baseRow, title: '=HYPERLINK("x")', senderName: '+55 Maria', accountName: '@conta' },
      { ...baseRow, title: '-1', senderName: '\tTab', accountName: '\rCR' },
    ]);
    const [, first, second] = csv.split('\r\n');

    expect(first).toContain(';"\'=HYPERLINK(""x"")";\'+55 Maria;');
    expect(first).toContain(";'@conta;");
    expect(second).toContain(";'-1;'\tTab;");
    expect(csv).toContain(';"\'\rCR";');
    expect(first?.startsWith('42;')).toBe(true);
    expect(first).toContain(';2.1.03;');
    expect(
      first?.endsWith(
        ';https://assinaturas.example/documents/42;Aguardando aprovação;;101;Puxada;Aguardando validação;',
      ),
    ).toBe(true);
  });

  it('deixa vazio o que não existe', () => {
    const csv = buildInvoiceExportCsv([
      {
        ...baseRow,
        choice: null,
        accountName: null,
        accountKind: null,
        suggestedCode: null,
        confidence: null,
        acceptedSuggestion: null,
      },
    ]);

    expect(lines(csv)[1]).toBe(
      '42;NF 123;Maria;29/10/2026 14:30;;Pendente;;;;;;;https://assinaturas.example/documents/42;Aguardando aprovação;;101;Puxada;Aguardando validação;',
    );
  });
});
