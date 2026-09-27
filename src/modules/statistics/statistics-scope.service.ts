import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../../common/auth-context.service';
import { isAdminUserType } from '../../common/auth/user-type';
import { FolderAccessService } from '../folders/folder-access.service';

/**
 * Which projects a statistics request may count. Admins see every folder (`folderIds` null skips
 * the folder filter instead of passing every folder id); other users see the folders they were
 * granted, and `empty` short-circuits users without any grant.
 */
export type StatisticsScope = {
  folderIds: string[] | null;
  isAdmin: boolean;
  userId: string;
  empty: boolean;
};

@Injectable()
export class StatisticsScopeService {
  constructor(private readonly folderAccess: FolderAccessService) {}

  async resolve(context: Pick<AuthContext, 'userId' | 'userType'>): Promise<StatisticsScope> {
    if (isAdminUserType(context.userType)) {
      return { folderIds: null, isAdmin: true, userId: context.userId, empty: false };
    }
    const folderIds = await this.folderAccess.accessibleFolderIds(context.userId, context.userType);
    return {
      folderIds,
      isAdmin: false,
      userId: context.userId,
      empty: folderIds.length === 0,
    };
  }
}
