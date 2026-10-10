
import { build } from "esbuild";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("./package.json");

// Loaded from node_modules at run time: the SDK locates its platform's Claude
// Code binary relative to its own install, which a bundle would lose.
const external = ["@anthropic-ai/claude-agent-sdk"];

await build({
  entryPoints: ["src/grey.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  external,
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    GREY_VERSION: JSON.stringify(version),
  },
  outfile: "dist/grey.mjs",
});

