import {
  assertClockSkew,
  assertMigrationsMatch,
  clockSkewSeconds,
  connectionHeadroomWarning,
  migrationTimestamp,
} from './worker-host-preflight-checks';

describe('worker host preflight checks', () => {
  describe('database connections', () => {
    it('passes while this host fits under max_connections', () => {
      expect(connectionHeadroomWarning({ max: 100, reserved: 3, open: 60, adding: 10 })).toBeNull();
    });

    it('warns when this host would push Postgres past max_connections', () => {
      expect(connectionHeadroomWarning({ max: 100, reserved: 3, open: 90, adding: 10 })).toContain(
        'Postgres allows 97 connections, 90 are open and this host',
      );
    });
  });

  describe('clock', () => {
    it('measures how far the host clock is ahead of the database', () => {
      expect(clockSkewSeconds(new Date(1_000_000), 1_060_400)).toBe(60);
      expect(clockSkewSeconds(new Date(1_060_400), 1_000_000)).toBe(-60);
    });

    it('passes a close clock, warns past 30 s and fails past 5 min', () => {
      expect(assertClockSkew(10)).toBeNull();
      expect(assertClockSkew(-60)).toContain('-60s off');
      expect(() => assertClockSkew(1200)).toThrow('1200s off');
    });
  });

  describe('migrations', () => {
    const image = ['AMigration1710000000000', 'BMigration1940000000000'];
    const executed = (...names: string[]) =>
      names.map((name) => ({ name, timestamp: migrationTimestamp(name) }));

    it('passes when the database ran exactly the image migrations', () => {
      expect(() => assertMigrationsMatch(executed(...image), image)).not.toThrow();
    });

    it('tolerates old migrations removed from the code', () => {
      expect(() =>
        assertMigrationsMatch(executed('OldMigration1700000000000', ...image), image),
      ).not.toThrow();
    });

    it('fails when the main host was not deployed yet', () => {
      expect(() => assertMigrationsMatch(executed('AMigration1710000000000'), image)).toThrow(
        'lacks migrations this image needs (BMigration1940000000000); deploy the main host',
      );
    });

    it('fails when this checkout is behind the main host', () => {
      expect(() =>
        assertMigrationsMatch(executed(...image, 'CMigration1950000000000'), image),
      ).toThrow('newer than this checkout (CMigration1950000000000); git pull');
    });
  });
});
