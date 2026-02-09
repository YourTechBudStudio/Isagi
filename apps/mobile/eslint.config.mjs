import { defineConfig, globalIgnores } from "eslint/config";
import expoConfig from "eslint-config-expo/flat";
import {
  baseLanguageOptions,
  baseRules,
  commonIgnores,
  plugins,
  prettierConfig,
  tsFiles,
} from "@isagi/tooling/eslint";

export default defineConfig([
  ...expoConfig,
  prettierConfig,
  globalIgnores([
    ...commonIgnores,
    ".expo",
    "android",
    "ios",
    "dist",
    "web-build",
  ]),
  {
    files: tsFiles,
    plugins,
    rules: baseRules,
    languageOptions: baseLanguageOptions,
  },
]);
