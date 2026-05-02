import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Type-aware linting scoped to the libsql migration surface area: the DB
  // layer + every typed settings helper that reads through it. After the
  // sync→async swap, `settings.get(key)` returns `Promise<unknown>` — if a
  // helper forgets to `await`, the Promise flows into `Schema.safeParse`,
  // becomes `{success: false}`, and silently falls back to defaults
  // (dropping the user's stored value). `no-floating-promises` +
  // `await-thenable` together catch both shapes of that mistake.
  //
  // Scope is narrow on purpose — broadening to all of src/ would surface
  // dozens of pre-existing issues unrelated to this migration. Widen in a
  // separate cleanup pass.
  {
    files: [
      "src/lib/db/**/*.ts",
      "src/lib/settings/**/*.ts",
      "src/lib/personas.ts",
      "src/lib/cli-health.ts",
      "tests/db.test.ts",
      "tests/settings-helpers.test.ts",
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Worktree artifacts and node_modules — never lint these.
    ".claude/**",
    "node_modules/**",
    "dist/**",
    "**/.next/**",
  ]),
]);

export default eslintConfig;
