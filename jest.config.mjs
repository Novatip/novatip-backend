/**
 * jest.config.mjs
 *
 * Plain ESM rather than TypeScript. Jest reads its config before any transform
 * is registered, so a .ts config needs ts-node to parse it — and under
 * "type": "module" that combination failed on Node 18 with
 * "SyntaxError: Unexpected token 'export'", which kept CI red on the lower half
 * of the matrix while Node 20 passed. The config itself is plain data, so it
 * gains nothing from being TypeScript. JSDoc keeps the editor types.
 *
 * @type {import("jest").Config}
 */
const config = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  // Only run the TypeScript sources. Without this, a prior `npm run build`
  // leaves compiled copies in dist/ and every suite runs twice.
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  moduleNameMapper: {
    // Rewrite .js imports to their .ts source so ts-jest can resolve them
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: {
          module: "ES2022",
          moduleResolution: "bundler",
        },
      },
    ],
  },
};

export default config;
