// Testes escritos antes da conta obrigatória (16/11/2026): quem age pelo link de um e-mail da empresa entra sozinho na
// conta desse e-mail (ver `account-helpers.mjs`). Basta importar este arquivo no começo do teste.
import { installCompanyRecipientAutoLogin } from './account-helpers.mjs';

installCompanyRecipientAutoLogin();
