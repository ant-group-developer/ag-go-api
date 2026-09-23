import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { AccountApiService } from './account-api.service';
import { AccountUserQueryDto } from './dto/account-user-query.dto';

@ApiTags('account')
@ApiBearerAuth()
@Controller('account')
export class AccountController {
  constructor(
    private readonly accountApi: AccountApiService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Lấy thông tin user hiện tại từ Account API' })
  getMe(@Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.accountApi.getCurrentUser(context.accessToken);
  }

  @Get('users')
  @ApiOperation({ summary: 'Proxy thông tin user hiện tại từ Account API' })
  getUsers(@Req() request: Request, @Query() query: AccountUserQueryDto) {
    const { userId } = this.authContext.getContext(request);
    return this.accountApi.getUsers(userId, query);
  }

  @Get('applications')
  @ApiOperation({ summary: 'Lấy danh sách application từ Account API' })
  getApplications() {
    return this.accountApi.getApplications();
  }
}
