import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { OrganisationMemberRole, TeamMemberRole } from '@prisma/client';
import {
  BellIcon, // REVALLE:
  BracesIcon,
  Building2Icon,
  CreditCardIcon,
  GroupIcon,
  LockIcon,
  MailboxIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserIcon,
  Users2Icon,
  WebhookIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { FaUsers } from 'react-icons/fa6';
import { IS_BILLING_ENABLED, IS_DOCUMENSO_CLOUD } from '../constants/app';
import { canExecuteOrganisationAction } from './organisations';
import { canExecuteTeamAction } from './teams';

export type SettingsNavScope = 'organisation' | 'team' | 'account';

export type SettingsNavItem = {
  key: string;
  path: string;
  label: MessageDescriptor;
  icon?: ComponentType<{ className?: string }>;
  isSubNav?: boolean;
  isSubNavParent?: boolean;
};

export type SettingsNavGroup = {
  scope: SettingsNavScope;
  items: SettingsNavItem[];
};

export type SettingsNavGroups = {
  organisation: SettingsNavGroup | null;
  team: SettingsNavGroup | null;
  account: SettingsNavGroup;
};

export type GetSettingsNavGroupsArgs = {
  organisation: {
    url: string;
    currentOrganisationRole: OrganisationMemberRole;
    organisationClaim: { flags: { emailDomains?: boolean; authenticationPortal?: boolean } };
  } | null;
  team: {
    url: string;
    currentTeamRole: TeamMemberRole;
  } | null;
  hasManageableBillingOrgs: boolean;
  /** REVALLE: administrador do sistema (`isAdmin(user)`); só ele vê Tokens de API e Webhooks. */
  isAdmin: boolean;
};

/**
 * Build the nav-group structure for the unified settings sidebar.
 *
 * Pure data helper — given a current organisation, optional current team, and the billing-enabled
 * flag, returns the items that should appear in each scope group. Groups the user has no manage
 * permission for are returned as `null` (not empty arrays) so consumers can branch on visibility.
 *
 * Item ordering, claim-flag gating, and which sections are scope-specific are encoded here as the
 * single source of truth for the unified-settings sidebar.
 */
export const getSettingsNavGroups = ({
  organisation,
  team,
  hasManageableBillingOrgs,
  isAdmin,
}: GetSettingsNavGroupsArgs): SettingsNavGroups => {
  const isBillingEnabled = IS_BILLING_ENABLED();
  const isDocumensoCloud = IS_DOCUMENSO_CLOUD();

  const canManageOrg =
    organisation !== null && canExecuteOrganisationAction('MANAGE_ORGANISATION', organisation.currentOrganisationRole);

  const canManageTeam = team !== null && canExecuteTeamAction('MANAGE_TEAM', team.currentTeamRole);

  const orgGroup: SettingsNavGroup | null = canManageOrg
    ? {
        scope: 'organisation',
        items: [
          {
            key: 'general',
            path: `/o/${organisation.url}/settings/general`,
            label: msg`General`,
            icon: Building2Icon,
          },
          // REVALLE: Marca, E-mail, preferências de documento e Certificados saem (Fase 7, spec §6); só Lembretes ficou.
          {
            key: 'reminders',
            path: `/o/${organisation.url}/settings/reminders`,
            label: msg`Reminders`,
            icon: BellIcon,
          },
          ...((isBillingEnabled && organisation.organisationClaim.flags.emailDomains) || isDocumensoCloud
            ? [
                {
                  key: 'email-domains',
                  path: `/o/${organisation.url}/settings/email-domains`,
                  label: msg`Email Domains`,
                  icon: MailboxIcon,
                },
              ]
            : []),
          {
            key: 'teams',
            path: `/o/${organisation.url}/settings/teams`,
            label: msg`Teams`,
            icon: FaUsers,
          },
          {
            key: 'members',
            path: `/o/${organisation.url}/settings/members`,
            label: msg`Members`,
            icon: Users2Icon,
          },
          {
            key: 'groups',
            path: `/o/${organisation.url}/settings/groups`,
            label: msg`Groups`,
            icon: GroupIcon,
          },
          ...((isBillingEnabled && organisation.organisationClaim.flags.authenticationPortal) || isDocumensoCloud
            ? [
                {
                  key: 'sso',
                  path: `/o/${organisation.url}/settings/sso`,
                  label: msg`SSO`,
                  icon: ShieldCheckIcon,
                },
              ]
            : []),
          ...(isBillingEnabled
            ? [
                {
                  key: 'billing',
                  path: `/o/${organisation.url}/settings/billing`,
                  label: msg`Billing`,
                  icon: CreditCardIcon,
                },
              ]
            : []),
        ],
      }
    : null;

  const teamGroup: SettingsNavGroup | null =
    canManageTeam && team
      ? {
          scope: 'team',
          items: [
            {
              key: 'general',
              path: `/t/${team.url}/settings/general`,
              label: msg`General`,
              icon: SettingsIcon,
            },
            // REVALLE: Marca, E-mail, preferências de documento e Certificados saem (Fase 7, spec §6); só Lembretes ficou.
            {
              key: 'reminders',
              path: `/t/${team.url}/settings/reminders`,
              label: msg`Reminders`,
              icon: BellIcon,
            },
            {
              key: 'members',
              path: `/t/${team.url}/settings/members`,
              label: msg`Members`,
              icon: Users2Icon,
            },
            {
              key: 'groups',
              path: `/t/${team.url}/settings/groups`,
              label: msg`Groups`,
              icon: GroupIcon,
            },
            // REVALLE: Perfil público sai; Tokens de API e Webhooks só para o administrador do sistema.
            ...(isAdmin
              ? [
                  {
                    key: 'tokens',
                    path: `/t/${team.url}/settings/tokens`,
                    label: msg`API Tokens`,
                    icon: BracesIcon,
                  },
                  {
                    key: 'webhooks',
                    path: `/t/${team.url}/settings/webhooks`,
                    label: msg`Webhooks`,
                    icon: WebhookIcon,
                  },
                ]
              : []),
          ],
        }
      : null;

  const accountGroup: SettingsNavGroup = {
    scope: 'account',
    items: [
      {
        key: 'profile',
        path: '/settings/profile',
        label: msg`Profile`,
        icon: UserIcon,
      },
      {
        key: 'organisations',
        path: '/settings/organisations',
        label: msg`Organisations`,
        icon: Building2Icon,
      },
      {
        key: 'security',
        path: '/settings/security',
        label: msg`Security`,
        icon: LockIcon,
      },
      ...(IS_BILLING_ENABLED() && hasManageableBillingOrgs
        ? [
            {
              key: 'billing',
              path: '/settings/billing',
              label: msg`Billing`,
              icon: CreditCardIcon,
            },
          ]
        : []),
    ],
  };

  return { organisation: orgGroup, team: teamGroup, account: accountGroup };
};
