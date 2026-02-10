const { defineConfig, globalIgnores } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");
const {
  baseLanguageOptions,
  baseRules,
  commonIgnores,
  plugins,
  prettierConfig,
  tsFiles,
} = require("@isagi/tooling/eslint");

module.exports = defineConfig([
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
