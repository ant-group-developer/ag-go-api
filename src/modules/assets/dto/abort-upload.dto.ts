import { IsUUID } from 'class-validator';

export class AbortUploadDto {
  @IsUUID()
  uploadSessionId!: string;
}
