import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
export default defineConfig({
  publicDir: "../../build/web-assets",
  plugins: [cloudflare()],
});
