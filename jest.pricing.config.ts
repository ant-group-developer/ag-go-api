import type { Config } from 'jest';
import base from './jest.config';

/** Pricing engine alone, with the coverage floor of NFR-04 (≥ 95%). */
const config: Config = {
  ...base,
  testRegex: 'modules/pricing-engine/.*\.spec\.ts$',
  collectCoverageFrom: ['modules/pricing-engine/**/*.ts', '!modules/pricing-engine/**/*.spec.ts'],
  coverageThreshold: {
    global: { branches: 95, functions: 95, lines: 95, statements: 95 },
  },
};

export default config;
