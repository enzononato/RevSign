// REVALLE: integração com o Patrimônio. Leitura do corpo dos pedidos (multipart da criação e JSON do cancelamento), com
// teto de bytes. Sem banco nem rede: testado no Vitest com `Request` de verdade.

import { PATRIMONIO_MAX_BODY_BYTES, PatrimonioError } from '../../../revalle/patrimonio/request';

/**
 * Lê o corpo com teto de bytes (o arquivo é de até 10 MB): passou do teto, FILE_TOO_LARGE sem ler o resto.
 */
export const readBodyWithLimit = async (request: Request, maxBytes: number): Promise<Uint8Array> => {
  const declared = Number(request.headers.get('content-length') ?? '');

  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PatrimonioError('FILE_TOO_LARGE', 'O arquivo passa de 10 MB.');
  }

  if (!request.body) {
    return new Uint8Array(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      // Para de ler e solta o resto (o servidor descarta o que sobrou ao responder).
      reader.releaseLock();

      throw new PatrimonioError('FILE_TOO_LARGE', 'O arquivo passa de 10 MB.');
    }

    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
};

/** Campos de texto e o arquivo do multipart da criação. */
export const readTermoMultipart = async (
  request: Request,
): Promise<{ fields: Record<string, string | undefined>; file: Buffer }> => {
  const contentType = request.headers.get('content-type') ?? '';

  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new PatrimonioError('INVALID_REQUEST', 'Envie multipart/form-data.');
  }

  const body = await readBodyWithLimit(request, PATRIMONIO_MAX_BODY_BYTES);

  let form: FormData;

  try {
    form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new PatrimonioError('INVALID_REQUEST', 'Multipart inválido.');
  }

  const fields: Record<string, string | undefined> = {};

  for (const name of ['externalId', 'kind', 'title', 'signerName', 'signerEmail', 'signerCpf', 'message']) {
    const values = form.getAll(name);

    if (values.length > 1 || values.some((value) => typeof value !== 'string')) {
      throw new PatrimonioError('INVALID_REQUEST', `Campo ${name} inválido.`);
    }

    fields[name] = values[0] as string | undefined;
  }

  const files = form.getAll('file');
  const [file] = files;

  if (files.length !== 1 || typeof file === 'string' || !file) {
    throw new PatrimonioError('INVALID_REQUEST', 'Envie um arquivo PDF no campo file.');
  }

  return { fields, file: Buffer.from(await file.arrayBuffer()) };
};

/** Corpo JSON opcional (cancelar). Vazio = undefined. */
export const readOptionalJson = async (request: Request): Promise<unknown> => {
  const body = await readBodyWithLimit(request, 16 * 1024).catch(() => {
    throw new PatrimonioError('INVALID_REQUEST', 'Corpo grande demais.');
  });
  const text = new TextDecoder().decode(body).trim();

  if (text === '') {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new PatrimonioError('INVALID_REQUEST', 'Corpo não é JSON válido.');
  }
};
