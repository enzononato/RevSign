import { describe, expect, it } from 'vitest';

import { PATRIMONIO_MAX_BODY_BYTES, PatrimonioError } from '../../../revalle/patrimonio/request';
import { readOptionalJson, readTermoMultipart } from './multipart';

const URL_ = 'http://localhost/api/revalle/patrimonio/v1/termos';

const formRequest = (form: FormData) => new Request(URL_, { method: 'POST', body: form });

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof PatrimonioError ? error.code : 'OTHER';
  }

  return null;
};

const baseForm = () => {
  const form = new FormData();

  form.append('externalId', 'PAT-1');
  form.append('kind', 'ENTREGA');
  form.append('title', 'Termo');
  form.append('signerName', 'Fulano');
  form.append('signerEmail', 'fulano@gmail.com');
  form.append('signerCpf', '39053344705');

  return form;
};

describe('readTermoMultipart', () => {
  it('lê os campos e o arquivo', async () => {
    const form = baseForm();

    form.append('file', new File(['%PDF-1.7 conteúdo'], 'termo.pdf', { type: 'application/pdf' }));

    const { fields, file } = await readTermoMultipart(formRequest(form));

    expect(fields).toMatchObject({ externalId: 'PAT-1', kind: 'ENTREGA', signerCpf: '39053344705' });
    expect(fields.message).toBeUndefined();
    expect(file.toString('utf8')).toBe('%PDF-1.7 conteúdo');
  });

  it('sem arquivo, com dois arquivos ou arquivo como texto → INVALID_REQUEST', async () => {
    expect(await codeOf(readTermoMultipart(formRequest(baseForm())))).toBe('INVALID_REQUEST');

    const two = baseForm();

    two.append('file', new File(['%PDF-'], 'a.pdf'));
    two.append('file', new File(['%PDF-'], 'b.pdf'));
    expect(await codeOf(readTermoMultipart(formRequest(two)))).toBe('INVALID_REQUEST');

    const text = baseForm();

    text.append('file', '%PDF-1.7');
    expect(await codeOf(readTermoMultipart(formRequest(text)))).toBe('INVALID_REQUEST');
  });

  it('campo repetido ou campo como arquivo → INVALID_REQUEST', async () => {
    const repeated = baseForm();

    repeated.append('externalId', 'PAT-2');
    repeated.append('file', new File(['%PDF-'], 'a.pdf'));
    expect(await codeOf(readTermoMultipart(formRequest(repeated)))).toBe('INVALID_REQUEST');

    const asFile = baseForm();

    asFile.set('title', new File(['x'], 'x.txt'));
    asFile.append('file', new File(['%PDF-'], 'a.pdf'));
    expect(await codeOf(readTermoMultipart(formRequest(asFile)))).toBe('INVALID_REQUEST');
  });

  it('JSON no lugar do multipart → INVALID_REQUEST', async () => {
    const request = new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(await codeOf(readTermoMultipart(request))).toBe('INVALID_REQUEST');
  });

  it('corpo acima do teto → FILE_TOO_LARGE, pelo Content-Length ou lendo', async () => {
    const declared = new Request(URL_, {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=x',
        'Content-Length': String(PATRIMONIO_MAX_BODY_BYTES + 1),
      },
      body: 'x',
    });

    expect(await codeOf(readTermoMultipart(declared))).toBe('FILE_TOO_LARGE');

    const form = baseForm();

    form.append('file', new File([new Uint8Array(PATRIMONIO_MAX_BODY_BYTES + 10)], 'grande.pdf'));
    expect(await codeOf(readTermoMultipart(formRequest(form)))).toBe('FILE_TOO_LARGE');
  });
});

describe('readOptionalJson', () => {
  const post = (body?: string) => new Request(URL_, { method: 'POST', body });

  it('vazio → undefined; JSON → objeto; texto inválido → INVALID_REQUEST', async () => {
    expect(await readOptionalJson(post())).toBeUndefined();
    expect(await readOptionalJson(post('  '))).toBeUndefined();
    expect(await readOptionalJson(post('{"reason":"x"}'))).toEqual({ reason: 'x' });
    expect(await codeOf(readOptionalJson(post('{reason')))).toBe('INVALID_REQUEST');
    expect(await codeOf(readOptionalJson(post('x'.repeat(17 * 1024))))).toBe('INVALID_REQUEST');
  });
});
