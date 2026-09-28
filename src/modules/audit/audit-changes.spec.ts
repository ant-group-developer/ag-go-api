import { diffAuditSnapshots } from './audit-changes';

describe('diffAuditSnapshots', () => {
  it('lists only the changed fields with their previous and new values', () => {
    expect(
      diffAuditSnapshots(
        { name: 'Old', description: 'Same', country: 'Việt Nam' },
        { name: 'New', description: 'Same', country: 'Lào' },
      ),
    ).toEqual([
      { field: 'name', from: 'Old', to: 'New' },
      { field: 'country', from: 'Việt Nam', to: 'Lào' },
    ]);
  });

  it('treats empty strings, empty lists and missing values as no value', () => {
    expect(
      diffAuditSnapshots(
        { description: '', tags: [], province: null },
        { description: null, tags: undefined, province: undefined },
      ),
    ).toEqual([]);
    expect(diffAuditSnapshots({ description: null }, { description: 'Added' })).toEqual([
      { field: 'description', from: null, to: 'Added' },
    ]);
  });

  it('ignores the order of list values', () => {
    expect(diffAuditSnapshots({ tags: ['a', 'b'] }, { tags: ['b', 'a'] })).toEqual([]);
    expect(diffAuditSnapshots({ tags: ['a'] }, { tags: ['a', 'b'] })).toEqual([
      { field: 'tags', from: ['a'], to: ['a', 'b'] },
    ]);
  });
});
