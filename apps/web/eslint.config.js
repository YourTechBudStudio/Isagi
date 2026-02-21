import { defineConfig, globalIgnores } from "eslint/config";
import {
  baseRules,
  commonIgnores,
  createLanguageOptions,
  plugins,
  prettierConfig,
  tsFiles,
  browserGlobals,
} from "@isagi/tooling/eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default defineConfig([
  prettierConfig,
  globalIgnores([...commonIgnores, "dist"]),
  {
    files: tsFiles,
    plugins: {
      ...plugins,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...baseRules,
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
    languageOptions: {
      ...createLanguageOptions(import.meta.dirname),
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: ["./tsconfig.app.json", "./tsconfig.node.json"],
      },
      globals: {
        ...createLanguageOptions(import.meta.dirname)?.globals,
        ...browserGlobals,
      },
    },
  },
]);
