import { defineConfig, globalIgnores } from "eslint/config";
import {
  baseRules,
  commonIgnores,
  createLanguageOptions,
  plugins,
  prettierConfig,
  tsFiles,
} from "@isagi/tooling/eslint";

export default defineConfig([
  prettierConfig,
  globalIgnores([...commonIgnores, "migrations"]),
  {
    files: tsFiles,
    plugins,
    rules: baseRules,
    languageOptions: createLanguageOptions(import.meta.dirname),
  },
]);
