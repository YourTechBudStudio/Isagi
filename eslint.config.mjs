import { globalIgnores } from "eslint/config";
import { commonIgnores } from "@isagi/tooling/eslint";

// Root level eslint config - mainly exists to ignore apps/packages
// Each app/package has its own eslint config
export default [globalIgnores([...commonIgnores, "apps", "packages"])];
