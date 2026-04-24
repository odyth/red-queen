import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md forbids the ! operator outside !=; we use === false / === true
      // as the explicit, positive form. Disable the lint that flags that pattern.
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/"],
  },
);
