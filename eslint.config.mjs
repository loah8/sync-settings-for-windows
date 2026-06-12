import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: [
      "main.js",
      "node_modules/**",
      "**/*.mjs",
      "**/*.js",
      "**/*.json",
    ],
  },
  ...obsidianmd.configs.recommended.map((cfg) => ({
    ...cfg,
    files: cfg.files ?? ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
  },
]);
