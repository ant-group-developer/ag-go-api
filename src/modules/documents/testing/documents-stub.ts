import type { DocumentsService } from '../documents.service';

export const STUB_TEMPLATE_ID = '00000000-0000-4000-8000-000000000d0c';

export const STUB_COMPANY = {
  name: 'CÔNG TY CỔ PHẦN ANT GROUP',
  taxCode: '0100000000',
  representative: 'Ông Nguyễn Văn A',
  title: 'Giám đốc',
  address: 'Hà Nội',
};

/**
 * DocumentsService for tests of contracts / acceptances that are not about documents: every check
 * passes and generation requests are recorded.
 */
export function documentsStub() {
  const calls = {
    prepareIssue: [] as unknown[][],
    requestGeneration: [] as unknown[],
    assertSignedFile: [] as unknown[][],
  };
  const stub = {
    calls,
    prepareIssue: async (...args: unknown[]) => {
      calls.prepareIssue.push(args);
      return { companySnapshot: STUB_COMPANY, templateId: STUB_TEMPLATE_ID };
    },
    requestGeneration: async (input: unknown) => {
      calls.requestGeneration.push(input);
      return {};
    },
    assertSignedFile: async (...args: unknown[]) => {
      calls.assertSignedFile.push(args);
    },
  };
  return stub as typeof stub & DocumentsService;
}
