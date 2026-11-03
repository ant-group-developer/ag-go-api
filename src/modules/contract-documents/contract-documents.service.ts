import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import type { DocumentOwnerType } from '../../database/entities/generated-document.entity';
import { PartnerEntity } from '../../database/entities/partner.entity';
import { AcceptancesService } from '../acceptances/acceptances.service';
import { buildPartnerSnapshot, ContractsService } from '../contracts/contracts.service';
import { CompanySettingsService } from '../documents/company-settings.service';
import {
  DOCUMENT_ERROR_CODES,
  DocumentsService,
  type UploadedFile,
} from '../documents/documents.service';
import type { DocumentFormat } from '../documents/dto/document.dto';
import type { CompanySnapshot, PartnerSnapshotData } from '../documents/render-data';
import { hasPermission, type PartnerActor } from '../partners/partner-actor';
import { PartnersService } from '../partners/partners.service';

type OwnerState = {
  contractId: string;
  partnerId: string;
  hasPartnerSnapshot: boolean;
  hasCompanySnapshot: boolean;
};

/**
 * Document endpoints of contracts, amendments and acceptance records (spec 6.5, 10, 13): who may
 * see the owner (its contract's manager, contract.read_all, admin), then DocumentsService does the
 * work. Previews of a draft print the partner's live AG Account profile (read and audited as a
 * view of personal data) and the current party A details; issued owners print their snapshots.
 */
@Injectable()
export class ContractDocumentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly contracts: ContractsService,
    private readonly acceptances: AcceptancesService,
    private readonly partners: PartnersService,
    private readonly documents: DocumentsService,
    private readonly company: CompanySettingsService,
  ) {}

  async list(
    ownerType: DocumentOwnerType,
    ownerId: string,
    actor: PartnerActor,
    contractId?: string,
  ) {
    const owner = await this.visibleOwner(ownerType, ownerId, actor, contractId);
    return ownerType === 'contract'
      ? this.documents.listForContract(owner.contractId)
      : this.documents.listForOwner(ownerType, ownerId);
  }

  async content(documentId: string, format: DocumentFormat, actor: PartnerActor) {
    const document = await this.documents.find(documentId);
    await this.visibleContract(document.contractId, actor);
    return this.documents.content(document, format, actor);
  }

  async versionContent(
    ownerType: DocumentOwnerType,
    ownerId: string,
    version: number,
    format: DocumentFormat,
    actor: PartnerActor,
    contractId?: string,
  ) {
    await this.visibleOwner(ownerType, ownerId, actor, contractId);
    const document = await this.documents.findVersion(ownerType, ownerId, version);
    return this.documents.content(document, format, actor);
  }

  async preview(
    ownerType: DocumentOwnerType,
    ownerId: string,
    format: DocumentFormat,
    actor: PartnerActor,
    contractId?: string,
  ) {
    const owner = await this.visibleOwner(ownerType, ownerId, actor, contractId);
    let partner: PartnerSnapshotData | undefined;
    let company: CompanySnapshot | undefined;
    if (!owner.hasPartnerSnapshot) {
      const row = await this.dataSource
        .getRepository(PartnerEntity)
        .findOneByOrFail({ id: owner.partnerId });
      const { profile } = await this.partners.readProfileForPreview(row, actor);
      partner = buildPartnerSnapshot(row, profile, new Date());
    }
    if (!owner.hasCompanySnapshot) {
      company = await this.company.current();
    }
    return this.documents.preview(ownerType, ownerId, { format, partner, company, actor });
  }

  async uploadSigned(
    ownerType: DocumentOwnerType,
    ownerId: string,
    file: UploadedFile | undefined,
    actor: PartnerActor,
    contractId?: string,
  ) {
    await this.visibleOwner(ownerType, ownerId, actor, contractId);
    return this.documents.uploadSigned(ownerType, ownerId, file, actor);
  }

  /** Contract / amendment files need go.contract.manage, acceptance files go.acceptance.approve. */
  async regenerate(documentId: string, actor: PartnerActor) {
    const document = await this.documents.find(documentId);
    await this.visibleContract(document.contractId, actor);
    const needed =
      document.ownerType === 'acceptance'
        ? GO_PERMISSIONS.ACCEPTANCE_APPROVE
        : GO_PERMISSIONS.CONTRACT_MANAGE;
    if (!hasPermission(actor, needed)) {
      throw new ForbiddenException({
        code: 'DOCUMENT_FORBIDDEN',
        message: `Regenerating this document needs ${needed}`,
      });
    }
    return this.documents.regenerate(document, actor);
  }

  private async visibleOwner(
    ownerType: DocumentOwnerType,
    ownerId: string,
    actor: PartnerActor,
    contractId?: string,
  ): Promise<OwnerState> {
    if (ownerType === 'acceptance') {
      const record = await this.acceptances.get(ownerId, actor);
      return {
        contractId: record.contractId,
        partnerId: record.partnerId,
        hasPartnerSnapshot: record.hasPartnerSnapshot,
        hasCompanySnapshot: record.companySnapshot !== null,
      };
    }
    const contract = await this.contracts.findVisible(contractId ?? ownerId, actor);
    if (ownerType === 'contract') {
      return {
        contractId: contract.id,
        partnerId: contract.partnerId,
        hasPartnerSnapshot: contract.partnerSnapshotAt !== null,
        hasCompanySnapshot: contract.companySnapshot !== null,
      };
    }
    const [amendment] = (await this.dataSource.query(
      `SELECT partner_snapshot_at AS "partnerSnapshotAt", company_snapshot AS "companySnapshot"
       FROM contract_amendments WHERE id = $1 AND contract_id = $2`,
      [ownerId, contract.id],
    )) as Array<{ partnerSnapshotAt: Date | null; companySnapshot: unknown }>;
    if (!amendment) {
      throw new NotFoundException({
        code: 'CONTRACT_AMENDMENT_NOT_FOUND',
        message: 'Amendment not found',
      });
    }
    return {
      contractId: contract.id,
      partnerId: contract.partnerId,
      hasPartnerSnapshot: amendment.partnerSnapshotAt !== null,
      hasCompanySnapshot: amendment.companySnapshot !== null,
    };
  }

  /** A document of a contract the actor cannot see is "not found". */
  private async visibleContract(contractId: string, actor: PartnerActor) {
    try {
      await this.contracts.findVisible(contractId, actor);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException({
          code: DOCUMENT_ERROR_CODES.NOT_FOUND,
          message: 'Document not found',
        });
      }
      throw error;
    }
  }
}
