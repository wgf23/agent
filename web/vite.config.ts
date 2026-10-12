import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The repo root is the parent of web/; it must be importable so the app can
// reach ../shared/protocol.ts outside the project directory.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			"/api": {
				target: "http://localhost:4317",
				changeOrigin: true,
				ws: false,
			},
		},
		fs: {
			allow: [repoRoot],
		},
	},
	build: {
		outDir: "dist",
	},
});
