import { describe, expect, it } from 'vitest';

import {
  buildRevalleStampLines,
  clampRevalleSignatureFieldSize,
  isRevalleStampOnlySignature,
  layoutRevalleStamp,
  REVALLE_SIGNATURE_FIELD_DEFAULT,
  REVALLE_SIGNATURE_FIELD_MIN,
} from './stamp';

// Largura aproximada da Noto Sans: 0,55 em por caractere (medida real: 0,45 a 0,57).
const measure = (text: string, size: number) => text.length * size * 0.55;

const input = {
  nome: 'João da Conceição',
  cpfMasked: '***.456.789-**',
  signedAt: new Date('2026-10-29T17:32:00Z'),
  verificationCode: '7KQ2-M9XA',
  baseUrl: 'https://assinatura.revalle.com.br/',
};

type Box = { x: number; y: number; width: number; height: number };

const A4 = { width: 595, height: 842 };

const hasCpfLine = (lines: string[]) => lines.some((line) => line.startsWith('CPF'));

const overlaps = (a: Box | null, b: Box) =>
  a !== null && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('buildRevalleStampLines', () => {
  it('monta as 5 linhas exatas, com o nome em maiúsculas pt-BR e a data de Brasília', () => {
    expect(buildRevalleStampLines(input)).toEqual([
      'Assinado eletronicamente por JOÃO DA CONCEIÇÃO',
      'CPF ***.456.789-**',
      'em 29/10/2026 14:32 (horário de Brasília)',
      'Código de verificação: 7KQ2-M9XA',
      'Confira em https://assinatura.revalle.com.br/verificar',
    ]);
  });

  it('sem CPF (checagem desligada) a linha 2 vira "CPF não verificado"', () => {
    expect(buildRevalleStampLines({ ...input, cpfMasked: null })[1]).toBe('CPF não verificado');
  });
});

describe('layoutRevalleStamp', () => {
  it('campo folgado: 5 linhas em 9 pt, sem desenho a caixa de texto é o campo inteiro', () => {
    const lines = buildRevalleStampLines(input);
    const layout = layoutRevalleStamp(lines, { width: 300, height: 80 }, false, measure);

    expect(layout.fontSize).toBe(9);
    expect(layout.lines).toEqual(lines);
    expect(layout.drawingBox).toBeNull();
    expect(layout.textBox.width).toBeGreaterThan(290);
  });

  it('nome de 60 caracteres em 120×40 pt: nenhuma linha passa da largura, fonte ≥ 5 e o código continua', () => {
    const lines = buildRevalleStampLines({
      ...input,
      nome: 'Maria Aparecida de Albuquerque Cavalcanti Figueiredo Santos X',
    });
    const layout = layoutRevalleStamp(lines, { width: 120, height: 40 }, false, measure);

    expect(layout.fontSize).toBeGreaterThanOrEqual(5);

    for (const line of layout.lines) {
      expect(measure(line, layout.fontSize)).toBeLessThanOrEqual(layout.textBox.width);
    }

    expect(layout.lines.length * layout.fontSize * layout.lineHeight).toBeLessThanOrEqual(layout.textBox.height);
    expect(layout.lines.join(' ')).toContain('7KQ2-M9XA');
    expect(layout.lines.join(' ').replace(/\s+/g, '')).toContain('FIGUEIREDOSANTOSX');
    expect(hasCpfLine(layout.lines)).toBe(true);
  });

  it('120×40 pt com o endereço de produção (que não cabe inteiro): o CPF continua', () => {
    const layout = layoutRevalleStamp(buildRevalleStampLines(input), { width: 120, height: 40 }, false, measure);

    expect(hasCpfLine(layout.lines)).toBe(true);
    expect(layout.lines.join(' ')).toContain('7KQ2-M9XA');
  });

  it('endereço longo quebra em "/" ou "." antes de cair para menos linhas', () => {
    const layout = layoutRevalleStamp(buildRevalleStampLines(input), { width: 120, height: 60 }, false, measure);

    expect(layout.level).toBe('FULL');
    expect(layout.lines.join('')).toContain('https://assinatura.revalle.com.br/verificar');
    expect(layout.lines.some((line) => /[./]$/.test(line))).toBe(true);
  });

  it('com desenho em 200×60 pt: o CPF continua', () => {
    const layout = layoutRevalleStamp(buildRevalleStampLines(input), { width: 200, height: 60 }, true, measure);

    expect(layout.drawingBox).not.toBeNull();
    expect(hasCpfLine(layout.lines)).toBe(true);
  });

  it('tamanho mínimo do campo de assinatura em A4: as 5 linhas cabem em 6 pt ou mais, sem desenho', () => {
    const lines = buildRevalleStampLines({ ...input, nome: 'Maria Aparecida dos Santos Oliveira' });

    for (const size of [REVALLE_SIGNATURE_FIELD_MIN, REVALLE_SIGNATURE_FIELD_DEFAULT]) {
      const box = { width: (A4.width * size.width) / 100, height: (A4.height * size.height) / 100 };
      const layout = layoutRevalleStamp(lines, box, false, measure);

      expect(layout.level).toBe('FULL');
      expect(layout.fontSize).toBeGreaterThanOrEqual(6);
    }
  });

  it('campo de 60×15 pt: só as linhas 1, 3 e 4 (sem CPF nem endereço), em 5 pt', () => {
    const lines = buildRevalleStampLines(input);
    const layout = layoutRevalleStamp(lines, { width: 60, height: 15 }, false, measure);
    const text = layout.lines.join(' ');

    expect(layout.level).toBe('ESSENTIAL');
    expect(layout.fontSize).toBe(5);
    expect(text).toContain('Assinado');
    expect(text).toContain('29/10/2026');
    expect(text).toContain('7KQ2-M9XA');
    expect(text).not.toContain('CPF');
    expect(text).not.toContain('Confira');
  });

  it('com desenho: o desenho fica nos 40% da esquerda e não sobrepõe o texto', () => {
    const layout = layoutRevalleStamp(buildRevalleStampLines(input), { width: 300, height: 60 }, true, measure);

    expect(layout.drawingBox).not.toBeNull();
    expect(layout.drawingBox?.x).toBe(0);
    expect(layout.drawingBox?.width).toBeCloseTo(120);
    expect(overlaps(layout.drawingBox, layout.textBox)).toBe(false);
  });

  it('com desenho em campo mais alto que largo: o desenho fica nos 40% de cima', () => {
    const layout = layoutRevalleStamp(buildRevalleStampLines(input), { width: 100, height: 200 }, true, measure);

    expect(layout.drawingBox).not.toBeNull();
    expect(layout.drawingBox?.y).toBe(0);
    expect(layout.drawingBox?.height).toBeCloseTo(80);
    expect(layout.drawingBox?.width).toBe(100);
    expect(overlaps(layout.drawingBox, layout.textBox)).toBe(false);
  });
});

describe('isRevalleStampOnlySignature', () => {
  const field = { type: 'SIGNATURE' as const, inserted: true };

  it('assinatura inserida sem imagem e sem texto é "só carimbo"', () => {
    expect(
      isRevalleStampOnlySignature({ ...field, signature: { signatureImageAsBase64: null, typedSignature: null } }),
    ).toBe(true);
    expect(
      isRevalleStampOnlySignature({ ...field, signature: { signatureImageAsBase64: '', typedSignature: '  ' } }),
    ).toBe(true);
  });

  it('desenho, texto, campo não inserido ou outro tipo não são', () => {
    expect(
      isRevalleStampOnlySignature({ ...field, signature: { signatureImageAsBase64: 'data:x', typedSignature: null } }),
    ).toBe(false);
    expect(
      isRevalleStampOnlySignature({ ...field, signature: { signatureImageAsBase64: null, typedSignature: 'Ana' } }),
    ).toBe(false);
    expect(isRevalleStampOnlySignature({ ...field, inserted: false, signature: null })).toBe(false);
    expect(isRevalleStampOnlySignature({ ...field, signature: null })).toBe(false);
    expect(
      isRevalleStampOnlySignature({
        type: 'NAME',
        inserted: true,
        signature: { signatureImageAsBase64: null, typedSignature: null },
      }),
    ).toBe(false);
  });
});

describe('clampRevalleSignatureFieldSize', () => {
  it('campo pequeno sobe para o mínimo; campo maior fica como está', () => {
    expect(clampRevalleSignatureFieldSize({ width: 5, height: 2 })).toEqual(REVALLE_SIGNATURE_FIELD_MIN);
    expect(clampRevalleSignatureFieldSize({ width: 50, height: 20 })).toEqual({ width: 50, height: 20 });
  });
});
