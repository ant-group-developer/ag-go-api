import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.db-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  // Run db-spec tests sequentially — they share a database and must not race.
  // The --runInBand flag is passed by the test:db script, not set here (runInBand
  // is a CLI option, not a Jest config property, and the Config type does not accept it).
  globalSetup: '<rootDir>/../jest.db-global-setup.ts',
};

export default config;
