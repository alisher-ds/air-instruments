import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative base so the build works from a GitHub Pages subpath (https://user.github.io/repo/).
  base: "./",
  build: {
    target: "es2022",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
