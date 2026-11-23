import { REVALLE_COLLABORATOR_CONTRACT_MAX_ROWS } from '@documenso/lib/revalle/collaborator-contract';
import { z } from 'zod';

import { ZContractIdSchema, ZSignatureRectSchema } from './shared.types';

export const ZCreateCollaboratorContractRequestSchema = z.object({
  /** O rascunho do assistente que está sendo enviado (sem ele, nasce um contrato novo). */
  contractId: ZContractIdSchema.optional(),
  title: z.string().trim().min(1).max(255),
  /** "Nome do remetente"; vazio = "Revalle". */
  senderName: z.string().trim().max(100).optional(),
  /** O PDF subido pelo fluxo de upload (`/api/files/upload-pdf`). */
  documentDataId: z.string().min(1).max(64),
  representativeEmail: z.string().trim().min(3).max(254),
  representativeRect: ZSignatureRectSchema,
  collaboratorRect: ZSignatureRectSchema,
  rows: z
    .array(
      z.object({
        name: z.string().max(255),
        email: z.string().max(254),
        cpf: z.string().max(20),
      }),
    )
    .min(1)
    .max(REVALLE_COLLABORATOR_CONTRACT_MAX_ROWS),
});

export const ZCreateCollaboratorContractResponseSchema = z.object({
  contractId: z.string(),
  /** O contrato foi criado, mas o convite ao representante não saiu: mostrar "Reenviar para o representante". */
  warning: z.literal('REPRESENTATIVE_NOT_SENT').optional(),
});

export type TCreateCollaboratorContractRequest = z.infer<typeof ZCreateCollaboratorContractRequestSchema>;
