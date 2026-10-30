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
};

const lines = (csv: string) => csv.split('\r\n');

describe('buildInvoiceExportCsv', () => {
  it('começa com BOM e tem o cabeçalho fixo', () => {
    const csv = buildInvoiceExportCsv([]);

    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines(csv)[0]).toBe(
      '﻿id;titulo;remetente;enviado_em;concluido_em;status;conta;nome_conta;tipo;sugestao_ia;confianca;aceitou_sugestao;link',
    );
  });

  it('escreve uma linha completa com datas de Brasília', () => {
    const csv = buildInvoiceExportCsv([baseRow]);

    expect(lines(csv)[1]).toBe(
      '42;NF 123;Maria;29/10/2026 14:30;;Pendente;2.1.03;Fornecedores;pagar;2.1.03;alta;sim;https://assinaturas.example/documents/42',
    );
  });

  it('coloca entre aspas o título com ponto e vírgula, aspas e quebra de linha', () => {
    const csv = buildInvoiceExportCsv([{ ...baseRow, title: 'NF; "teste"\nfim' }]);

    expect(csv).toContain('42;"NF; ""teste""\nfim";Maria');
  });

  it('mostra DEFER como a definir pela contabilidade', () => {
    const csv = buildInvoiceExportCsv([
      { ...baseRow, choice: 'DEFER', accountName: null, accountKind: null, acceptedSuggestion: false },
    ]);

    expect(lines(csv)[1]).toContain(';a definir pela contabilidade;;;');
    expect(lines(csv)[1]).not.toContain('DEFER');
    expect(lines(csv)[1]).toContain(';não;');
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
      '42;NF 123;Maria;29/10/2026 14:30;;Pendente;;;;;;;https://assinaturas.example/documents/42',
    );
  });
});
