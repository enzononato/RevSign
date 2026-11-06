import { formatDocumentsPath, formatTemplatesPath } from '@documenso/lib/utils/teams';
import { trpc } from '@documenso/trpc/react';
import type { TFolderWithSubfolders } from '@documenso/trpc/server/folder-router/schema';
import { Button } from '@documenso/ui/primitives/button';
import { Card, CardContent } from '@documenso/ui/primitives/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@documenso/ui/primitives/dropdown-menu';
import { Plural, Trans } from '@lingui/react/macro';
import { FolderType } from '@prisma/client';
import {
  ArrowRightIcon,
  FolderIcon,
  FolderPlusIcon,
  MoreVerticalIcon,
  PinIcon,
  SettingsIcon,
  TrashIcon,
} from 'lucide-react';
import { Link } from 'react-router';

import { useCurrentTeam } from '~/providers/team';

export type FolderCardProps = {
  folder: TFolderWithSubfolders;
  onMove: (folder: TFolderWithSubfolders) => void;
  onSettings: (folder: TFolderWithSubfolders) => void;
  onDelete: (folder: TFolderWithSubfolders) => void;
};

export const FolderCard = ({ folder, onMove, onSettings, onDelete }: FolderCardProps) => {
  const team = useCurrentTeam();

  const { mutateAsync: updateFolderMutation } = trpc.folder.updateFolder.useMutation();

  const formatPath = () => {
    const rootPath =
      folder.type === FolderType.DOCUMENT ? formatDocumentsPath(team.url) : formatTemplatesPath(team.url);

    return `${rootPath}/f/${folder.id}`;
  };

  const updateFolder = async ({ pinned }: { pinned: boolean }) => {
    await updateFolderMutation({
      folderId: folder.id,
      data: {
        pinned,
      },
    });
  };

  return (
    // REVALLE v3: pasta como cartão macio (raio 20, sombra de cartão, ícone num ladrilho azul-claro)
    <Link
      to={formatPath()}
      data-folder-id={folder.id}
      data-folder-name={folder.name}
      className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Card className="h-full transition-colors hover:bg-accent/40">
        <CardContent className="p-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-accent text-brand-text">
              <FolderIcon className="h-5 w-5" />
            </span>

            <div className="flex w-full min-w-0 items-center justify-between">
              <div className="min-w-0 flex-1">
                <h3 className="flex min-w-0 items-center gap-2 font-bold">
                  <span className="truncate">{folder.name}</span>
                  {folder.pinned && <PinIcon className="h-3 w-3 flex-shrink-0 text-brand-text" />}
                </h3>

                <div className="mt-1 flex space-x-2 truncate text-muted-foreground text-xs">
                  <span>
                    {folder.type === FolderType.TEMPLATE ? (
                      <Plural
                        value={folder._count.templates}
                        one={<Trans># template</Trans>}
                        other={<Trans># templates</Trans>}
                      />
                    ) : (
                      <Plural
                        value={folder._count.documents}
                        one={<Trans># document</Trans>}
                        other={<Trans># documents</Trans>}
                      />
                    )}
                  </span>
                  <span>•</span>
                  <span>
                    <Plural
                      value={folder._count.subfolders}
                      one={<Trans># folder</Trans>}
                      other={<Trans># folders</Trans>}
                    />
                  </span>
                </div>
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-10 w-10 p-0" data-testid="folder-card-more-button">
                    <MoreVerticalIcon className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>

                <DropdownMenuContent onClick={(e) => e.stopPropagation()} align="end">
                  <DropdownMenuItem onClick={() => onMove(folder)}>
                    <ArrowRightIcon className="mr-2 h-4 w-4" />
                    <Trans>Move</Trans>
                  </DropdownMenuItem>

                  <DropdownMenuItem onClick={async () => updateFolder({ pinned: !folder.pinned })}>
                    <PinIcon className="mr-2 h-4 w-4" />
                    {folder.pinned ? <Trans>Unpin</Trans> : <Trans>Pin</Trans>}
                  </DropdownMenuItem>

                  <DropdownMenuItem onClick={() => onSettings(folder)}>
                    <SettingsIcon className="mr-2 h-4 w-4" />
                    <Trans>Settings</Trans>
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem onClick={() => onDelete(folder)}>
                    <TrashIcon className="mr-2 h-4 w-4" />
                    <Trans>Delete</Trans>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
};

export const FolderCardEmpty = ({ type }: { type: FolderType }) => {
  return (
    // REVALLE v3: cartão macio, como as pastas
    <Card className="h-full transition-colors hover:bg-accent/40">
      <CardContent className="p-3.5">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-muted text-muted-foreground">
            <FolderPlusIcon className="h-5 w-5" />
          </span>

          <div>
            <h3 className="flex items-center gap-2 font-medium text-muted-foreground">
              <Trans>Create folder</Trans>
            </h3>

            <div className="mt-1 flex space-x-2 truncate text-muted-foreground text-xs">
              {type === FolderType.DOCUMENT ? (
                <Trans>Organise your documents</Trans>
              ) : (
                <Trans>Organise your templates</Trans>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
