import { Module } from '@nestjs/common';
import { R2StorageAdapter } from './r2-storage.adapter';
import { STORAGE_ADAPTER } from './storage-adapter';

@Module({
  providers: [
    R2StorageAdapter,
    {
      provide: STORAGE_ADAPTER,
      useExisting: R2StorageAdapter,
    },
  ],
  exports: [STORAGE_ADAPTER],
})
export class StorageModule {}
