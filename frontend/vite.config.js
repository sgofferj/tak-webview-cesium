import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

export default defineConfig({
  plugins: [cesium()],
  server: {
    proxy: {
      "/config": "http://localhost:8000",
      "/iconsets": "http://localhost:8000",
      "/user_iconsets": "http://localhost:8000",
      "/locales": "http://localhost:8000",
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
      },
    },
  },
});
