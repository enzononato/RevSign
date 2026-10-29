import { z } from 'zod';

export const ZAdminDeleteLinkRequestSchema = z.object({ linkId: z.string().min(1) });

export const ZAdminDeleteLinkResponseSchema = z.void();

export type TAdminDeleteLinkRequest = z.infer<typeof ZAdminDeleteLinkRequestSchema>;
