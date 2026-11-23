import { describe, expect, it } from 'vitest';

import {
  buildCollaboratorContractLine,
  buildCollaboratorStatusCsv,
  bulkSendFailureLabel,
  collaboratorDocStatus,
  dedupeCollaboratorRows,
  revalleBulkSendBatchSize,
} from './collaborator-contract';

describe('revalleBulkSendBatchSize', () => {
  it('default is 100 per hour, 25 per 15-minute sweep', () => {
    expect(revalleBulkSendBatchSize(undefined)).toBe(25);
    expect(revalleBulkSendBatchSize('')).toBe(25);
  });

  it('divides the hourly rate by 4, rounding up', () => {
    expect(revalleBulkSendBatchSize('100')).toBe(25);
    expect(revalleBulkSendBatchSize('10')).toBe(3);
    expect(revalleBulkSendBatchSize('1')).toBe(1);
    expect(revalleBulkSendBatchSize(' 400 ')).toBe(100);
    expect(revalleBulkSendBatchSize('99.9')).toBe(25);
  });

  it('invalid, zero or negative values use the default', () => {
    for (const value of ['abc', '0', '-20', 'NaN', 'Infinity']) {
      expect(revalleBulkSendBatchSize(value)).toBe(25);
    }
  });
});

describe('dedupeCollaboratorRows', () => {
  it('keeps the first row of each e-mail and counts the repeated ones', () => {
    const result = dedupeCollaboratorRows([
      { name: ' Ana ', email: 'Ana@Revalle.com.br' },
      { name: 'Bruno', email: 'bruno@revalle.com.br' },
      { name: 'Ana de novo', email: ' ana@revalle.com.br ' },
      { name: '', email: 'BRUNO@revalle.com.br' },
    ]);

    expect(result.duplicates).toBe(2);
    expect(result.rows).toEqual([
      { name: 'Ana', email: 'ana@revalle.com.br' },
      { name: 'Bruno', email: 'bruno@revalle.com.br' },
    ]);
  });

  it('missing names become empty strings', () => {
    expect(dedupeCollaboratorRows([{ email: 'a@b.com' }]).rows).toEqual([{ name: '', email: 'a@b.com' }]);
  });
});

describe('buildCollaboratorContractLine', () => {
  it('names the representative, the date in Brasília time and the verification code', () => {
    expect(
      buildCollaboratorContractLine({
        representativeName: 'Maria Souza',
        signedAt: new Date('2026-11-23T17:05:00Z'),
        verificationCode: 'ABCD-EFGH',
      }),
    ).toBe('Assinado pela empresa: Maria Souza em 23/11/2026 14:05 (horário de Brasília), código ABCD-EFGH');
  });

  it('falls back to "Representante" without a name', () => {
    expect(
      buildCollaboratorContractLine({
        representativeName: ' ',
        signedAt: '2026-11-23T17:05:00Z',
        verificationCode: 'X',
      }),
    ).toMatch(/^Assinado pela empresa: Representante em /);
  });
});

describe('collaboratorDocStatus', () => {
  it('queue status wins until the document is sent', () => {
    expect(collaboratorDocStatus({ queueStatus: 'QUEUED', signingStatus: 'NOT_SIGNED', readStatus: null })).toBe(
      'QUEUED',
    );
    expect(collaboratorDocStatus({ queueStatus: 'FAILED', signingStatus: 'NOT_SIGNED', readStatus: null })).toBe(
      'FAILED',
    );
  });

  it('after sending, signed / rejected / opened / sent', () => {
    expect(collaboratorDocStatus({ queueStatus: 'SENT', signingStatus: 'SIGNED', readStatus: 'OPENED' })).toBe(
      'SIGNED',
    );
    expect(collaboratorDocStatus({ queueStatus: 'SENT', signingStatus: 'REJECTED', readStatus: 'OPENED' })).toBe(
      'REJECTED',
    );
    expect(collaboratorDocStatus({ queueStatus: 'SENT', signingStatus: 'NOT_SIGNED', readStatus: 'OPENED' })).toBe(
      'OPENED',
    );
    expect(collaboratorDocStatus({ queueStatus: 'SENT', signingStatus: 'NOT_SIGNED', readStatus: 'NOT_OPENED' })).toBe(
      'SENT',
    );
  });
});

describe('buildCollaboratorStatusCsv', () => {
  it('nome;email;situação;data with BOM, failure reason and neutralised formulas', () => {
    const csv = buildCollaboratorStatusCsv([
      {
        name: '=HYPERLINK("x")',
        email: 'a@revalle.com.br',
        status: 'SIGNED',
        failureCode: null,
        date: new Date('2026-11-23T17:05:00Z'),
      },
      {
        name: 'Bruno',
        email: 'b@revalle.com.br',
        status: 'FAILED',
        failureCode: 'MISSING_SIGNATURE_FIELD',
        date: null,
      },
    ]);

    expect(csv.startsWith('﻿nome;email;situação;data\r\n')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")";a@revalle.com.br;Assinado;23/11/2026 14:05\r\n`);
    expect(csv).toContain('Bruno;b@revalle.com.br;Falhou: Falta a posição da assinatura do colaborador no modelo;\r\n');
  });
});

describe('bulkSendFailureLabel', () => {
  it('unknown codes keep the code, never a message', () => {
    expect(bulkSendFailureLabel('SOMETHING')).toBe('Erro no envio (SOMETHING)');
    expect(bulkSendFailureLabel(null)).toBe('Erro no envio');
  });
});
