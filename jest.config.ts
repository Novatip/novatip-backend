import type { Config } from "jest";

const config: Config = {
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
