import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths: the site must work mounted at /swarm/ on
  // GitHub Pages as well as at a domain root.
  base: "./",
  server: {
    port: 5193,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
});
