// ============= Full file contents =============
// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Load all env vars into process.env for server routes only (the shared
// config already injects VITE_* vars for client code — do not duplicate).
const serverEnv = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
Object.assign(process.env, serverEnv);

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    resolve: {
      alias: {
        // Pin entities to the hoisted v4.5.0 copy; a nested v7 breaks SSR.
        "entities/lib/decode.js": path.resolve(dirname, "node_modules/entities/lib/decode.js"),
        "entities/lib/encode.js": path.resolve(dirname, "node_modules/entities/lib/encode.js"),
        entities: path.resolve(dirname, "node_modules/entities"),
      },
    },
  },
});
