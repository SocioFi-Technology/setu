/* Production build (staging plan, week 2): one ESM bundle, dist/server.js, run with plain `node` — no tsx. The
   workspace packages (@setu/*, @setu/db is TypeScript source) are bundled in; every other package stays in node_modules
   (Prisma's generated client, playwright-core, the native argon2 binding, fastify and the rest). */
import { build } from "esbuild";

const workspaceOnly = {
  name: "externals",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (a) => (a.path.startsWith("@setu/") ? undefined : { path: a.path, external: true }));
  },
};
await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  plugins: [workspaceOnly],
  // a bundled ESM file has no require(): give the CommonJS packages one
  banner: { js: "import { createRequire as __setuCreateRequire } from 'node:module'; const require = __setuCreateRequire(import.meta.url);" },
  logLevel: "info",
});
