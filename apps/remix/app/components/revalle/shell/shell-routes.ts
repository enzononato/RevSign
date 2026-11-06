import type { CSSProperties } from 'react';

type RouteMatchLike = { id?: string } | undefined;

const EDITOR_ROUTE_IDS = [
  'routes/_authenticated+/t.$teamUrl+/documents.$id.edit',
  'routes/_authenticated+/t.$teamUrl+/templates.$id.edit',
];

const AUTHENTICATED_LAYOUT_ID = 'routes/_authenticated+/_layout';

/** Editor routes keep their own full-screen layout, without the blue shell. */
export const isEditorRoute = (matches: RouteMatchLike[]) =>
  matches.some((match) => match?.id !== undefined && EDITOR_ROUTE_IDS.includes(match.id));

/** True when the page is drawn inside the blue shell (sidebar on desktop, top bar on mobile). */
export const isInsideAppShell = (matches: RouteMatchLike[]) =>
  matches.some((match) => match?.id === AUTHENTICATED_LAYOUT_ID) && !isEditorRoute(matches);

/** The 24px hairline grid drawn over the shell blue. */
export const SHELL_GRID_STYLE: CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 1px, transparent 1px 24px), repeating-linear-gradient(0deg, rgba(255,255,255,.045) 0 1px, transparent 1px 24px)',
};
