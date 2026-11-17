/* global module, require */
const base = require('./jest.config');

module.exports = {
  ...base,
  testRegex: '\\.integration\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 120000,
  maxWorkers: 1,
};
