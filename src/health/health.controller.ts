import { Controller, Get, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectDataSource } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { Public } from '../common/auth/public.decorator';

@ApiTags('system')
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController implements OnModuleDestroy {
  private redis?: Redis;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness check' })
  getHealth() {
    return {
      status: 'ok',
      service: 'ag-go-api',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness check verifying database and Redis connections' })
  async getReady() {
    let dbStatus: 'ok' | 'error' = 'ok';
    let redisStatus: 'ok' | 'error' = 'ok';
    let dbError: string | undefined;
    let redisError: string | undefined;

    try {
      await this.dataSource.query('SELECT 1');
    } catch (err) {
      dbStatus = 'error';
      dbError = err instanceof Error ? err.message : String(err);
    }

    try {
      const pong = await this.pingRedis();
      if (pong !== 'PONG') {
        redisStatus = 'error';
        redisError = `Unexpected response: ${pong}`;
      }
    } catch (err) {
      redisStatus = 'error';
      redisError = err instanceof Error ? err.message : String(err);
    }

    if (dbStatus !== 'ok' || redisStatus !== 'ok') {
      throw new ServiceUnavailableException({
        status: 'error',
        service: 'ag-go-api',
        database: dbStatus,
        redis: redisStatus,
        errors: { db: dbError, redis: redisError },
        timestamp: new Date().toISOString(),
      });
    }

    return {
      status: 'ok',
      service: 'ag-go-api',
      database: dbStatus,
      redis: redisStatus,
      timestamp: new Date().toISOString(),
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => undefined);
      this.redis = undefined;
    }
  }

  private async pingRedis(): Promise<string> {
    const redis = this.getRedis();
    return Promise.race([
      redis.ping(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Redis ping timed out after 2000ms')), 2000),
      ),
    ]);
  }

  private getRedis(): Redis {
    if (!this.redis) {
      this.redis = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: false,
      });
      this.redis.on('error', () => undefined);
    }
    return this.redis;
  }
}
