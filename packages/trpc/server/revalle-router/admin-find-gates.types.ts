import { z } from 'zod';

export const ZAdminFindGatesRequestSchema = z.object({
  type: z.enum(['LOCKED', 'LINKS']),
  search: z.string().max(254).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(50),
});

export const ZAdminFindGatesResponseSchema = z.object({
  locked: z.array(
    z.object({
      id: z.string(),
      documentTitle: z.string(),
      recipientEmail: z.string(),
      reason: z.enum(['ATTEMPTS', 'CPF_CONFLICT', 'CODE_ATTEMPTS']),
      conflictEmail: z.string().nullable(),
      lockedAt: z.date(),
    }),
  ),
  links: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
      cpfMasked: z.string(),
      createdAt: z.date(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export type TAdminFindGatesRequest = z.infer<typeof ZAdminFindGatesRequestSchema>;
