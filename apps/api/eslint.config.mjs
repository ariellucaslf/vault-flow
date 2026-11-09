import { config } from "@repo/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    files: ["test/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        process: "readonly",
        Buffer: "readonly",
        AbortController: "readonly",
        setImmediate: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];
