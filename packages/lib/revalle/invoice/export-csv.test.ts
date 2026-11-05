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
  supplierName: null,
  invoiceNumber: null,
  totalAmountCents: null,
};

const lines = (csv: string) => csv.split('\r\n');

describe('buildInvoiceExportCsv', () => {
  it('começa com BOM e tem o cabeçalho fixo', () => {
    const csv = buildInvoiceExportCsv([]);

    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines(csv)[0]).toBe(
      '﻿id;titulo;remetente;enviado_em;concluido_em;status;conta;nome_conta;tipo;sugestao_ia;confianca;aceitou_sugestao;link;financeiro;aprovado_por;centro_custo;nome_centro_custo;validacao_contabilidade;validado_por;fornecedor;numero_nf;valor',
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
    expect(header.slice(15, 19)).toEqual([
      'centro_custo',
      'nome_centro_custo',
      'validacao_contabilidade',
      'validado_por',
    ]);
  });

  it('Fase 7: centro, situação da validação e quem validou (nome congelado, neutralizado como texto livre)', () => {
    const validated = buildInvoiceExportCsv([
      { ...baseRow, accountingStatus: 'Validado', validatedBy: '=Contabilidade Ana' },
    ]);
    const withoutCenter = buildInvoiceExportCsv([
      { ...baseRow, costCenterCode: null, costCenterName: null, accountingStatus: 'Sem centro de custo' },
    ]);

    expect(lines(validated)[1]?.endsWith(";;101;Puxada;Validado;'=Contabilidade Ana;;;")).toBe(true);
    expect(lines(withoutCenter)[1]?.endsWith(';Aguardando aprovação;;;;Sem centro de custo;;;;')).toBe(true);
    expect(
      lines(buildInvoiceExportCsv([baseRow]))[1]?.endsWith(
        ';Aguardando aprovação;;101;Puxada;Aguardando validação;;;;',
      ),
    ).toBe(true);
  });

  it('escreve uma linha completa com datas de Brasília', () => {
    const csv = buildInvoiceExportCsv([baseRow]);

    expect(lines(csv)[1]).toBe(
      '42;NF 123;Maria;29/10/2026 14:30;;Pendente;2.1.03;Fornecedores;pagar;2.1.03;alta;sim;https://assinaturas.example/documents/42;Aguardando aprovação;;101;Puxada;Aguardando validação;;;;',
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
        ';https://assinaturas.example/documents/42;Aguardando aprovação;;101;Puxada;Aguardando validação;;;;',
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
      '42;NF 123;Maria;29/10/2026 14:30;;Pendente;;;;;;;https://assinaturas.example/documents/42;Aguardando aprovação;;101;Puxada;Aguardando validação;;;;',
    );
  });

  it('Fase 8: fornecedor, número da NF e valor vêm depois de validado_por e as anteriores não mudam de posição', () => {
    const header = lines(buildInvoiceExportCsv([]))[0]?.replace('﻿', '').split(';') ?? [];

    expect(header).toHaveLength(22);
    expect(header.slice(15, 19)).toEqual([
      'centro_custo',
      'nome_centro_custo',
      'validacao_contabilidade',
      'validado_por',
    ]);
    expect(header.slice(19)).toEqual(['fornecedor', 'numero_nf', 'valor']);
  });

  it('Fase 8: escreve o fornecedor, o número e o valor lidos da NF, com vírgula nos centavos', () => {
    const csv = buildInvoiceExportCsv([
      { ...baseRow, supplierName: 'ACME LTDA', invoiceNumber: '12345', totalAmountCents: 123456 },
    ]);

    expect(lines(csv)[1]?.endsWith(';Aguardando validação;;ACME LTDA;12345;1234,56')).toBe(true);
    expect(lines(csv)[1]?.split(';')).toHaveLength(22);
  });

  it('Fase 8: texto lido do documento com ponto e vírgula fica entre aspas', () => {
    const csv = buildInvoiceExportCsv([{ ...baseRow, supplierName: 'Comércio; "Bom" Ltda' }]);

    expect(lines(csv)[1]?.endsWith(';"Comércio; ""Bom"" Ltda";;')).toBe(true);
  });

  it('Fase 8: célula de texto que começa com =, +, - ou @ sai com apóstrofo, em todas as colunas de texto', () => {
    const formula = '=HYPERLINK("x")';
    const csv = buildInvoiceExportCsv([
      {
        ...baseRow,
        title: formula,
        senderName: '+1',
        status: '-status',
        choice: '@conta',
        accountName: formula,
        suggestedCode: '=1+1',
        confidence: '@alta',
        link: '=link',
        financeStatus: '+fin',
        approvedBy: '-ana',
        costCenterCode: '=1',
        costCenterName: '@c',
        accountingStatus: '=contab',
        validatedBy: '+val',
        supplierName: formula,
        invoiceNumber: '-123',
      },
    ]);
    const cells = (lines(csv)[1] ?? '').split(';');

    // Os textos com aspas e ponto e vírgula ficam entre aspas, então confere célula por célula pelo conteúdo.
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);

    for (const text of [
      "'+1",
      "'-status",
      "'@conta",
      "'=1+1",
      "'@alta",
      "'=link",
      "'+fin",
      "'-ana",
      "'=1",
      "'@c",
      "'=contab",
      "'+val",
      "'-123",
    ]) {
      expect(cells, text).toContain(text);
    }

    expect(csv.match(/"'=HYPERLINK\(""x""\)"/g)).toHaveLength(3);
  });

  it('Fase 8: o valor, a data e o id nunca ganham apóstrofo', () => {
    const csv = buildInvoiceExportCsv([{ ...baseRow, totalAmountCents: 5, invoiceNumber: '000123' }]);

    expect(lines(csv)[1]?.startsWith('42;')).toBe(true);
    expect(lines(csv)[1]?.endsWith(';;000123;0,05')).toBe(true);
    expect(lines(csv)[1]).toContain(';29/10/2026 14:30;');
  });
});
