import type { RecipientRole } from '@prisma/client';
import { z } from 'zod';

import { formatRevalleDateTime } from './date-format';

// REVALLE: linhas da prova congelada de cada destinatário no certificado de assinatura (Fase 4).

export type RevalleCertificateRow = { label: string; value: string };

/** Colunas de `RevalleSignatureProof` usadas no certificado; os campos JSON chegam como estão no banco. */
export type RevalleCertificateProof = {
  employee: unknown;
  factors: unknown;
  termVersion: string | null;
  termAcceptedAt: Date | string | null;
  ipLocation: unknown;
  deviceLocation: unknown;
  signatureKind: string;
  verificationCode: string;
};

const EMPTY = '—';

const ZEmployee = z.object({
  cpfMasked: z.string(),
  matricula: z.string().nullish(),
  cargo: z.string().nullish(),
  setor: z.string().nullish(),
  unidade: z.string().nullish(),
  situacao: z.string().nullish(),
});

const ZFactors = z.array(z.object({ factor: z.string(), at: z.string().nullish() }));

const ZIpLocation = z.object({
  city: z.string().nullish(),
  region: z.string().nullish(),
  country: z.string().nullish(),
  countryIso: z.string().nullish(),
});

const ZDeviceLocation = z.object({
  status: z.string(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  accuracyM: z.number().optional(),
});

const FACTOR_LABELS: Record<string, string> = {
  EMAIL_LINK: 'Link por e-mail',
  EMAIL_CODE: 'Código por e-mail',
  EMPLOYEE_CONFIRMATION: 'Confirmação de colaborador',
  EMPLOYEE_LINKED: 'Vínculo de colaborador já confirmado',
};

const DEVICE_LOCATION_LABELS: Record<string, string> = {
  DENIED: 'não autorizada',
  UNAVAILABLE: 'indisponível',
  NOT_REQUESTED: 'não solicitada',
};

const SIGNATURE_KIND_LABELS: Record<string, string> = {
  IMAGE: 'imagem (desenho/arquivo)',
  TYPED: 'texto digitado',
  NONE: 'somente carimbo',
};

const orEmpty = (value: string | null | undefined) => value?.trim() || EMPTY;

const formatFactors = (factors: unknown) => {
  const parsed = ZFactors.safeParse(factors);

  if (!parsed.success) {
    return EMPTY;
  }

  const parts = parsed.data
    .filter((item) => item.at && FACTOR_LABELS[item.factor])
    .map((item) => `${FACTOR_LABELS[item.factor]} (${formatRevalleDateTime(item.at as string)})`);

  return parts.length > 0 ? parts.join(' · ') : EMPTY;
};

const formatTerm = (version: string | null, acceptedAt: Date | string | null) => {
  if (!version) {
    return EMPTY;
  }

  return acceptedAt ? `Versão ${version} em ${formatRevalleDateTime(acceptedAt)}` : `Versão ${version}`;
};

const countryName = (iso: string | null | undefined, fallback: string | null | undefined) => {
  if (iso?.toUpperCase() === 'BR') {
    return 'Brasil';
  }

  if (iso) {
    try {
      return new Intl.DisplayNames(['pt-BR'], { type: 'region' }).of(iso.toUpperCase()) ?? fallback ?? iso;
    } catch {
      return fallback ?? iso;
    }
  }

  return fallback ?? null;
};

const formatIpLocation = (ipLocation: unknown) => {
  const parsed = ZIpLocation.safeParse(ipLocation);

  if (!parsed.success) {
    return 'não identificada';
  }

  const { city, region, country, countryIso } = parsed.data;
  const place = [city, region].filter(Boolean).join('/');
  const text = [place, countryName(countryIso, country)].filter(Boolean).join(', ');

  return text || 'não identificada';
};

const coordinate = (value: number) => value.toFixed(4).replace('.', ',');

const formatDeviceLocation = (deviceLocation: unknown) => {
  const parsed = ZDeviceLocation.safeParse(deviceLocation);

  if (!parsed.success) {
    return DEVICE_LOCATION_LABELS.NOT_REQUESTED;
  }

  const { status, lat, lon, accuracyM } = parsed.data;

  if (status === 'GRANTED' && lat !== undefined && lon !== undefined) {
    // Espaço não separável antes de "m": a quebra de linha do certificado não deixa a unidade sozinha.
    const accuracy =
      accuracyM !== undefined
        ? ` (±${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(accuracyM)}\u00a0m)`
        : '';

    return `${coordinate(lat)}, ${coordinate(lon)}${accuracy}`;
  }

  return DEVICE_LOCATION_LABELS[status] ?? DEVICE_LOCATION_LABELS.UNAVAILABLE;
};

/**
 * Linhas do certificado a partir da prova congelada, nesta ordem. Nunca recebe o CPF completo:
 * só o `cpfMasked` gravado na prova. Sem CPF na prova (verificação desligada), "não verificado".
 */
export const buildRevalleCertificateRows = (
  proof: RevalleCertificateProof,
  { role }: { role: RecipientRole },
): RevalleCertificateRow[] => {
  const employee = ZEmployee.safeParse(proof.employee);
  const hr = employee.success ? employee.data : null;

  const rows: RevalleCertificateRow[] = [
    { label: 'CPF', value: hr ? orEmpty(hr.cpfMasked) : 'não verificado' },
    { label: 'Matrícula', value: orEmpty(hr?.matricula) },
    { label: 'Cargo', value: orEmpty(hr?.cargo) },
    { label: 'Setor', value: orEmpty(hr?.setor) },
    { label: 'Unidade', value: orEmpty(hr?.unidade) },
    { label: 'Situação', value: orEmpty(hr?.situacao) },
    { label: 'Verificação', value: formatFactors(proof.factors) },
    { label: 'Termo aceito', value: formatTerm(proof.termVersion, proof.termAcceptedAt) },
    { label: 'Localização aproximada (IP)', value: formatIpLocation(proof.ipLocation) },
    { label: 'Localização do aparelho', value: formatDeviceLocation(proof.deviceLocation) },
  ];

  if (role === 'SIGNER') {
    rows.push({ label: 'Assinatura visual', value: SIGNATURE_KIND_LABELS[proof.signatureKind] ?? EMPTY });
  }

  rows.push({ label: 'Código de verificação', value: proof.verificationCode });

  return rows;
};
