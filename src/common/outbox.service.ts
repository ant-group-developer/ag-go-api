import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity';

export type CreateOutboxEventInput = {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
};

@Injectable()
export class OutboxService {
  constructor(
    @InjectRepository(OutboxEventEntity)
    private readonly repository: Repository<OutboxEventEntity>,
  ) {}

  create(manager: EntityManager, input: CreateOutboxEventInput): OutboxEventEntity {
    return manager.create(OutboxEventEntity, {
      id: uuidv7(),
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload,
      status: 'pending',
      attemptCount: 0,
      availableAt: new Date(),
      publishedAt: null,
      lastError: null,
    });
  }

  async createStandalone(input: CreateOutboxEventInput): Promise<OutboxEventEntity> {
    return this.repository.save(
      this.repository.create({
        ...input,
        id: uuidv7(),
        status: 'pending',
        attemptCount: 0,
        availableAt: new Date(),
        publishedAt: null,
        lastError: null,
      }),
    );
  }
}
