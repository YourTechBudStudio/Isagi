import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

/**
 * Prettier configuration - should be first in your config array
 */
export const prettierConfig = eslintPluginPrettierRecommended;

/**
 * Common plugins for TypeScript projects
 */
export const plugins = {
  "@typescript-eslint": tseslint.plugin,
  "simple-import-sort": simpleImportSort,
};

/**
 * Base rules for all TypeScript projects
 */
export const baseRules = {
  ...tseslint.configs.recommended.rules,
  semi: ["error", "always"],
  "simple-import-sort/imports": "error",
  "simple-import-sort/exports": "error",
  "@typescript-eslint/no-unused-vars": [
    "error",
    { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
  ],
};

/**
 * Common file patterns for TypeScript files
 */
export const tsFiles = ["**/*.ts", "**/*.tsx", "**/*.mts"];

/**
 * Common ignore patterns
 */
export const commonIgnores = ["dist", "out", "node_modules"];

/**
 * Base language options with TypeScript parser (no type-checking)
 * Use this for projects that don't need type-aware linting
 */
export const baseLanguageOptions = {
  parser: tseslint.parser,
  ecmaVersion: 2022,
  sourceType: "module",
};

/**
 * Creates language options with type-checking enabled
 * @param {string} dirname - The directory of the eslint config file (use import.meta.dirname)
 */
export function createLanguageOptions(dirname) {
  return {
    ...baseLanguageOptions,
    parserOptions: {
      tsconfigRootDir: dirname,
      project: ["./tsconfig.json"],
    },
  };
}
