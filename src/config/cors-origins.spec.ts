import { corsOrigins } from './cors-origins';

describe('corsOrigins', () => {
  it('allows only ag-go-web when no extra origin is set', () => {
    expect(corsOrigins('http://localhost:5173', undefined)).toEqual(['http://localhost:5173']);
    expect(corsOrigins('http://localhost:5173', '')).toEqual(['http://localhost:5173']);
  });

  it('adds the extra web apps, trimmed, without trailing slashes or repeats', () => {
    expect(
      corsOrigins(
        'https://go.example.com/',
        ' https://studio.example.com/ , https://go.example.com,,http://localhost:3100',
      ),
    ).toEqual(['https://go.example.com', 'https://studio.example.com', 'http://localhost:3100']);
  });
});
