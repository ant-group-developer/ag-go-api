import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { AnalysisFarmJobEntity } from '../../../database/entities/analysis-farm-job.entity';
import { TicketClaims, TicketError, extractTicket, verifyTicket } from './ticket';

export const FARM_OWNER_ID = 'ag-go';

/** The verified ticket claims are attached here for the controller to read. */
export const TICKET_CLAIMS_KEY = 'farmTicketClaims';

declare module 'express-serve-static-core' {
  interface Request {
    farmTicketClaims?: TicketClaims;
    farmJob?: AnalysisFarmJobEntity;
  }
}

/**
 * Guards the farm sign endpoint.
 * Verifies the Ed25519 JWT ticket from `Authorization: Ticket <jwt>`, then checks:
 *  1. The job exists in analysis_farm_jobs and is not yet ingested.
 *  2. The `owner` claim is `ag-go`.
 * Attaches `req.farmTicketClaims` and `req.farmJob` for downstream use.
 */
@Injectable()
export class FarmTicketGuard implements CanActivate {
  private readonly logger = new Logger(FarmTicketGuard.name);

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(AnalysisFarmJobEntity)
    private readonly farmJobRepo: Repository<AnalysisFarmJobEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const authorization = req.headers['authorization'] as string | undefined;

    const token = extractTicket(authorization);
    if (!token) {
      throw new UnauthorizedException('Missing or invalid Ticket authorization header');
    }

    const publicKeyPem = this.config.get<string>('FARM_TICKET_PUBLIC_KEY');
    if (!publicKeyPem) {
      throw new ForbiddenException('FARM_TICKET_PUBLIC_KEY is not configured');
    }

    let claims: TicketClaims;
    try {
      claims = verifyTicket(token, publicKeyPem, { owner: FARM_OWNER_ID });
    } catch (error) {
      if (error instanceof TicketError) {
        this.logger.warn(`Ticket rejected: ${error.reason} — ${error.message}`);
        if (error.reason === 'expired') {
          throw new UnauthorizedException('Farm ticket is expired');
        }
        throw new UnauthorizedException(`Farm ticket invalid: ${error.reason}`);
      }
      throw error;
    }

    // The job must exist in our DB and must not have been ingested yet
    const job = await this.farmJobRepo.findOne({ where: { farmJobId: claims.job_id } });
    if (!job) {
      throw new ForbiddenException(`Unknown farm job: ${claims.job_id}`);
    }
    if (job.ingestedAt) {
      throw new ForbiddenException(`Farm job ${claims.job_id} has already been ingested`);
    }

    req.farmTicketClaims = claims;
    req.farmJob = job;
    return true;
  }
}
