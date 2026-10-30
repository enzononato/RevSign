import { JobClient } from './client/client';
import { REVALLE_SEND_FINANCE_ACCOUNT_CHANGED_EMAIL_JOB_DEFINITION } from './definitions/emails/revalle-send-finance-account-changed-email'; // REVALLE: conta trocada pelo Financeiro
import { REVALLE_SEND_FINANCE_APPROVAL_EMAIL_JOB_DEFINITION } from './definitions/emails/revalle-send-finance-approval-email'; // REVALLE: NF aguardando aprovação
import { REVALLE_SEND_FINANCE_AWAITING_EMAIL_JOB_DEFINITION } from './definitions/emails/revalle-send-finance-awaiting-email'; // REVALLE: NF aguardando o Financeiro
import { REVALLE_SEND_INVOICE_ACCOUNTING_EMAIL_JOB_DEFINITION } from './definitions/emails/revalle-send-invoice-accounting-email'; // REVALLE: e-mail da contabilidade
import { SEND_ACCOUNT_DISABLED_EMAIL_JOB_DEFINITION } from './definitions/emails/send-account-disabled-email';
import { SEND_ADMIN_RECIPIENT_REMOVED_EMAILS_JOB_DEFINITION } from './definitions/emails/send-admin-recipient-removed-emails';
import { SEND_ADMIN_USER_CREATED_EMAIL_JOB_DEFINITION } from './definitions/emails/send-admin-user-created-email';
import { SEND_CONFIRMATION_EMAIL_JOB_DEFINITION } from './definitions/emails/send-confirmation-email';
import { SEND_DOCUMENT_CANCELLED_EMAILS_JOB_DEFINITION } from './definitions/emails/send-document-cancelled-emails';
import { SEND_DOCUMENT_COMPLETED_EMAILS_JOB_DEFINITION } from './definitions/emails/send-document-completed-emails';
import { SEND_DOCUMENT_CREATED_FROM_DIRECT_TEMPLATE_EMAIL_JOB_DEFINITION } from './definitions/emails/send-document-created-from-direct-template-email';
import { SEND_DOCUMENT_DELETED_EMAILS_JOB_DEFINITION } from './definitions/emails/send-document-deleted-emails';
import { SEND_DOCUMENT_PENDING_EMAIL_JOB_DEFINITION } from './definitions/emails/send-document-pending-email';
import { SEND_ORGANISATION_LIMIT_ALERT_EMAIL_JOB_DEFINITION } from './definitions/emails/send-organisation-limit-alert-email';
import { SEND_ORGANISATION_LIMITS_UPDATED_EMAIL_JOB_DEFINITION } from './definitions/emails/send-organisation-limits-updated-email';
import { SEND_ORGANISATION_MEMBER_JOINED_EMAIL_JOB_DEFINITION } from './definitions/emails/send-organisation-member-joined-email';
import { SEND_ORGANISATION_MEMBER_LEFT_EMAIL_JOB_DEFINITION } from './definitions/emails/send-organisation-member-left-email';
import { SEND_OWNER_RECIPIENT_EXPIRED_EMAIL_JOB_DEFINITION } from './definitions/emails/send-owner-recipient-expired-email';
import { SEND_PASSWORD_RESET_SUCCESS_EMAIL_JOB_DEFINITION } from './definitions/emails/send-password-reset-success-email';
import { SEND_RECIPIENT_REMOVED_EMAIL_JOB_DEFINITION } from './definitions/emails/send-recipient-removed-email';
import { SEND_RECIPIENT_SIGNED_EMAIL_JOB_DEFINITION } from './definitions/emails/send-recipient-signed-email';
import { SEND_SIGNING_REJECTION_EMAILS_JOB_DEFINITION } from './definitions/emails/send-rejection-emails';
import { SEND_SIGNING_EMAIL_JOB_DEFINITION } from './definitions/emails/send-signing-email';
import { SEND_TEAM_DELETED_EMAIL_JOB_DEFINITION } from './definitions/emails/send-team-deleted-email';
import { ADMIN_DELETE_ORGANISATION_JOB_DEFINITION } from './definitions/internal/admin-delete-organisation';
import { ALERT_ORGANISATION_SEAT_DRIFT_JOB_DEFINITION } from './definitions/internal/alert-organisation-seat-drift';
import { BACKPORT_SUBSCRIPTION_CLAIM_JOB_DEFINITION } from './definitions/internal/backport-subscription-claims';
import { BULK_SEND_TEMPLATE_JOB_DEFINITION } from './definitions/internal/bulk-send-template';
import { CANCEL_ORGANISATION_SUBSCRIPTION_JOB_DEFINITION } from './definitions/internal/cancel-organisation-subscription';
import { CLEANUP_AUTH_HANDOFFS_JOB_DEFINITION } from './definitions/internal/cleanup-auth-handoffs';
import { CLEANUP_RATE_LIMITS_JOB_DEFINITION } from './definitions/internal/cleanup-rate-limits';
import { EXECUTE_WEBHOOK_JOB_DEFINITION } from './definitions/internal/execute-webhook';
import { EXPIRE_RECIPIENTS_SWEEP_JOB_DEFINITION } from './definitions/internal/expire-recipients-sweep';
import { PROCESS_RECIPIENT_EXPIRED_JOB_DEFINITION } from './definitions/internal/process-recipient-expired';
import { PROCESS_SIGNING_REMINDER_JOB_DEFINITION } from './definitions/internal/process-signing-reminder';
import { REVALLE_INVOICE_SUGGEST_JOB_DEFINITION } from './definitions/internal/revalle-invoice-suggest'; // REVALLE: sugestão de conta da nota fiscal
import { SEAL_DOCUMENT_JOB_DEFINITION } from './definitions/internal/seal-document';
import { SEAL_DOCUMENT_SWEEP_JOB_DEFINITION } from './definitions/internal/seal-document-sweep';
import { SEND_SIGNING_REMINDERS_SWEEP_JOB_DEFINITION } from './definitions/internal/send-signing-reminders-sweep';
import { SYNC_EMAIL_DOMAINS_JOB_DEFINITION } from './definitions/internal/sync-email-domains';
import { SYNC_ORGANISATION_SEATS_JOB_DEFINITION } from './definitions/internal/sync-organisation-seats';

/**
 * The `as const` assertion is load bearing as it provides the correct level of type inference for
 * triggering jobs.
 */
export const jobsClient = new JobClient([
  SEND_ACCOUNT_DISABLED_EMAIL_JOB_DEFINITION,
  SEND_ADMIN_USER_CREATED_EMAIL_JOB_DEFINITION,
  SEND_SIGNING_EMAIL_JOB_DEFINITION,
  SEND_CONFIRMATION_EMAIL_JOB_DEFINITION,
  SEND_ORGANISATION_MEMBER_JOINED_EMAIL_JOB_DEFINITION,
  SEND_ORGANISATION_MEMBER_LEFT_EMAIL_JOB_DEFINITION,
  SEND_ORGANISATION_LIMIT_ALERT_EMAIL_JOB_DEFINITION,
  SEND_ORGANISATION_LIMITS_UPDATED_EMAIL_JOB_DEFINITION,
  SEND_TEAM_DELETED_EMAIL_JOB_DEFINITION,
  SEAL_DOCUMENT_JOB_DEFINITION,
  SEAL_DOCUMENT_SWEEP_JOB_DEFINITION,
  SEND_PASSWORD_RESET_SUCCESS_EMAIL_JOB_DEFINITION,
  SEND_SIGNING_REJECTION_EMAILS_JOB_DEFINITION,
  SEND_RECIPIENT_SIGNED_EMAIL_JOB_DEFINITION,
  SEND_RECIPIENT_REMOVED_EMAIL_JOB_DEFINITION,
  SEND_ADMIN_RECIPIENT_REMOVED_EMAILS_JOB_DEFINITION,
  SEND_DOCUMENT_COMPLETED_EMAILS_JOB_DEFINITION,
  SEND_DOCUMENT_DELETED_EMAILS_JOB_DEFINITION,
  SEND_DOCUMENT_CANCELLED_EMAILS_JOB_DEFINITION,
  SEND_DOCUMENT_CREATED_FROM_DIRECT_TEMPLATE_EMAIL_JOB_DEFINITION,
  SEND_DOCUMENT_PENDING_EMAIL_JOB_DEFINITION,
  SEND_OWNER_RECIPIENT_EXPIRED_EMAIL_JOB_DEFINITION,
  BACKPORT_SUBSCRIPTION_CLAIM_JOB_DEFINITION,
  BULK_SEND_TEMPLATE_JOB_DEFINITION,
  EXECUTE_WEBHOOK_JOB_DEFINITION,
  EXPIRE_RECIPIENTS_SWEEP_JOB_DEFINITION,
  PROCESS_RECIPIENT_EXPIRED_JOB_DEFINITION,
  SEND_SIGNING_REMINDERS_SWEEP_JOB_DEFINITION,
  PROCESS_SIGNING_REMINDER_JOB_DEFINITION,
  CLEANUP_RATE_LIMITS_JOB_DEFINITION,
  CLEANUP_AUTH_HANDOFFS_JOB_DEFINITION,
  SYNC_EMAIL_DOMAINS_JOB_DEFINITION,
  ADMIN_DELETE_ORGANISATION_JOB_DEFINITION,
  ALERT_ORGANISATION_SEAT_DRIFT_JOB_DEFINITION,
  CANCEL_ORGANISATION_SUBSCRIPTION_JOB_DEFINITION,
  SYNC_ORGANISATION_SEATS_JOB_DEFINITION,
  // REVALLE: sugestão de conta contábil da nota fiscal (Fase 5).
  REVALLE_INVOICE_SUGGEST_JOB_DEFINITION,
  // REVALLE: e-mail para a contabilidade na conclusão da nota fiscal (Fase 5).
  REVALLE_SEND_INVOICE_ACCOUNTING_EMAIL_JOB_DEFINITION,
  // REVALLE: aviso aos membros do Financeiro de que uma NF retida espera a conta (Fase 6).
  REVALLE_SEND_FINANCE_AWAITING_EMAIL_JOB_DEFINITION,
  // REVALLE: aviso aos membros do Financeiro de que uma NF assinada espera a aprovação para ser selada (Fase 6).
  REVALLE_SEND_FINANCE_APPROVAL_EMAIL_JOB_DEFINITION,
  // REVALLE: aviso da troca de conta pelo Financeiro (nova versão) ao remetente e aos destinatários (Fase 6).
  REVALLE_SEND_FINANCE_ACCOUNT_CHANGED_EMAIL_JOB_DEFINITION,
] as const);

export const jobs = jobsClient;
