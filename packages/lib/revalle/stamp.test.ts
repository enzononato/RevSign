import { describe, expect, it } from 'vitest';

import { buildRevalleStampLines, layoutRevalleStamp } from './stamp';

// Largura aproximada de uma fonte sem serifa: 0,55 em por caractere.
const measure = (text: string, size: number) => text.length * size * 0.55;

const input = {
  nome: 'João da Conceição',
  cpfMasked: '***.456.789-**',
  signedAt: new Date('2026-10-29T17:32:00Z'),
  verificationCode: '7KQ2-M9XA',
  baseUrl: 'https://assinatura.revalle.com.br/',
};

type Box = { x: number; y: number; width: number; height: number };

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
  });

  it('campo de 60×15 pt: só as linhas 1, 3 e 4 (sem CPF nem endereço), em 5 pt', () => {
    const lines = buildRevalleStampLines(input);
    const layout = layoutRevalleStamp(lines, { width: 60, height: 15 }, false, measure);
    const text = layout.lines.join(' ');

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
