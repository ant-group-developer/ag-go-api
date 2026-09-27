import { addFileToUploadBatchSummary } from './media-upload-batch-summary';

describe('addFileToUploadBatchSummary', () => {
  const uploadedAt = new Date('2026-09-27T11:00:00.000Z');

  it('starts a batch from its first file', () => {
    expect(
      addFileToUploadBatchSummary(
        null,
        'batch-1',
        { filename: 'a.jpg', assetType: 'image', sizeBytes: 100 },
        uploadedAt,
      ),
    ).toEqual({
      uploadBatchId: 'batch-1',
      fileCount: 1,
      imageCount: 1,
      videoCount: 0,
      totalBytes: 100,
      files: [{ name: 'a.jpg', assetType: 'image' }],
      lastUploadedAt: '2026-09-27T11:00:00.000Z',
    });
  });

  it('adds later files to the counters', () => {
    const first = addFileToUploadBatchSummary(
      null,
      'batch-1',
      { filename: 'a.jpg', assetType: 'image', sizeBytes: 100 },
      uploadedAt,
    );
    const second = addFileToUploadBatchSummary(
      first,
      'batch-1',
      { filename: 'b.mp4', assetType: 'video', sizeBytes: 900 },
      uploadedAt,
    );

    expect(second).toMatchObject({
      fileCount: 2,
      imageCount: 1,
      videoCount: 1,
      totalBytes: 1000,
      files: [
        { name: 'a.jpg', assetType: 'image' },
        { name: 'b.mp4', assetType: 'video' },
      ],
    });
  });

  it('keeps counting past the listed file names', () => {
    let summary: Record<string, unknown> | null = null;
    for (let index = 0; index < 12; index += 1) {
      summary = addFileToUploadBatchSummary(
        summary,
        'batch-1',
        { filename: `${index}.jpg`, assetType: 'image', sizeBytes: 1 },
        uploadedAt,
      );
    }

    expect(summary).toMatchObject({ fileCount: 12, imageCount: 12, totalBytes: 12 });
    expect((summary as { files: unknown[] }).files).toHaveLength(10);
  });
});
