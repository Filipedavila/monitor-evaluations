/* global module, require */
const path = require('path');
const { compilerOptions } = require('./tsconfig.json');

function escapeRegex(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function getModuleNameMapper(paths) {
  const mapper = {};
  for (const [alias, pathsArray] of Object.entries(paths)) {
    // Escapa caracteres especiais de regex e substitui o wildcard
    const key = '^' + escapeRegex(alias).replace('*', '(.*)') + '$';
    // Normaliza o caminho (remove "./") para o jest resolver corretamente
    const target = '<rootDir>/' + path.posix.normalize(pathsArray[0]).replace('*', '$1');
    mapper[key] = target;
  }
  return mapper;
}

module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  // Garante que tanto o código fonte como a pasta de testes são analisados pelo Jest
  roots: ['<rootDir>/src', '<rootDir>/test'],
  // Diz ao Jest onde procurar módulos base
  moduleDirectories: ['node_modules', '<rootDir>'],
  testRegex: '.spec.ts$',
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.spec\\.ts$'],
  moduleNameMapper: {
    ...getModuleNameMapper(compilerOptions.paths),
  },
  transform: {
    '^.+\\.(t|j)s$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2022',
          parser: {
            syntax: 'typescript',
            decorators: true,
          },
          transform: {
            legacyDecorator: true,
            decoratorMetadata: true,
          },
        },
      },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!uuid)/'],
  collectCoverageFrom: [
    '**/*.(t|j)s',
    '!main.(t|j)s',
    '!**/*.module.(t|j)s',
    '!**/*.dto.(t|j)s',
    '!**/*.entity.(t|j)s',
    '!**/*.args.(t|j)s',
    '!**/*.types.(t|j)s',
    '!**/node_modules/**',
  ],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
};
