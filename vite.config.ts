import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

const repoRoot = __dirname;
const namesCsvPath = path.join(repoRoot, "names.csv");
const audioDirectoryPath = path.join(repoRoot, "audio");

const writeFileIfPresent = (sourcePath: string, destinationPath: string): void => {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
};

const copyDirectoryIfPresent = (sourcePath: string, destinationPath: string): void => {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  fs.mkdirSync(destinationPath, { recursive: true });
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceEntry = path.join(sourcePath, entry.name);
    const destinationEntry = path.join(destinationPath, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryIfPresent(sourceEntry, destinationEntry);
      continue;
    }

    fs.copyFileSync(sourceEntry, destinationEntry);
  }
};

const repoStaticAssetsPlugin = (): Plugin => ({
  name: "repo-static-assets",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const requestUrl = req.url ?? "";

      if (requestUrl === "/names.csv") {
        if (!fs.existsSync(namesCsvPath)) {
          res.statusCode = 404;
          res.end("names.csv not found");
          return;
        }

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        fs.createReadStream(namesCsvPath).pipe(res);
        return;
      }

      if (requestUrl.startsWith("/audio/")) {
        const relativeAudioPath = requestUrl.slice("/audio/".length);
        const safeAudioPath = path.normalize(relativeAudioPath).replace(/^(\.\.(\/|\\|$))+/, "");
        const audioFilePath = path.join(audioDirectoryPath, safeAudioPath);

        if (!audioFilePath.startsWith(audioDirectoryPath) || !fs.existsSync(audioFilePath)) {
          res.statusCode = 404;
          res.end("audio file not found");
          return;
        }

        res.setHeader("Content-Type", "audio/wav");
        fs.createReadStream(audioFilePath).pipe(res);
        return;
      }

      next();
    });
  },
  writeBundle(options) {
    const outputDirectory = options.dir ? path.resolve(repoRoot, options.dir) : path.join(repoRoot, "dist");
    writeFileIfPresent(namesCsvPath, path.join(outputDirectory, "names.csv"));
    copyDirectoryIfPresent(audioDirectoryPath, path.join(outputDirectory, "audio"));
  }
});

export default defineConfig({
  plugins: [repoStaticAssetsPlugin()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/healthz": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true
      },
      "/ocr": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true
      },
      "/runtime": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true
      },
      "/shutdown": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true
      }
    }
  },
  build: {
    target: "chrome120"
  }
});
