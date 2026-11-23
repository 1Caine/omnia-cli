import { defineConfig } from "tsup";
import { bundle } from "../mcp/tsup.config";

// One self-contained file: the SDK, the MCP server and their libraries are bundled in, so `npx omnia-cli` installs a single package.
export default defineConfig({ ...bundle, entry: { index: "src/index.ts" } });
