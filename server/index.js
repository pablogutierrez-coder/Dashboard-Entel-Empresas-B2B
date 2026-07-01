import cors from "cors";
import express from "express";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { listEvaluationFolderFiles, validateDriveConnection } from "./drive.js";
import { readSharedRecord } from "./firebase.js";
import { getRealtimeDatabaseFileBlob } from "./fileBlobs.js";
import { gasHandlers } from "./gasHandlers.js";
import { getFirebaseStorageFileStream, validateFirebaseStorageConnection } from "./storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");

const app = express();
app.use(cors());
app.use(express.json({ limit: "80mb" }));
app.use(express.urlencoded({ extended: true, limit: "80mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mode: "local-node", timestamp: new Date().toISOString() });
});

app.get("/api/firebase/shared/:key.json", async (req, res, next) => {
  try {
    const record = await readSharedRecord(req.params.key);
    res.json(record || null);
  } catch (error) {
    next(error);
  }
});

app.get("/api/drive/validate", async (_req, res, next) => {
  try {
    res.json(await validateDriveConnection());
  } catch (error) {
    next(error);
  }
});

app.get("/api/storage/validate", async (_req, res, next) => {
  try {
    res.json(await validateFirebaseStorageConnection());
  } catch (error) {
    next(error);
  }
});

app.get("/api/storage/files/:storagePath/content", async (req, res, next) => {
  try {
    const storagePath = decodeURIComponent(String(req.params.storagePath || "").trim());
    if (!storagePath) {
      res.status(400).json({ ok: false, error: "storagePath requerido." });
      return;
    }
    const { stream, metadata, status } = await getFirebaseStorageFileStream(storagePath, String(req.headers.range || ""));
    const size = Number(metadata.size || 0) || 0;
    const contentType = metadata.contentType || "application/octet-stream";
    res.status(status);
    res.setHeader("content-type", contentType);
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("cache-control", "private, max-age=3600");
    if (status === 206 && req.headers.range && size) {
      const match = String(req.headers.range).match(/bytes=(\d*)-(\d*)/);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : size - 1;
      res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
      res.setHeader("content-length", Math.max(0, end - start + 1));
    } else if (size) {
      res.setHeader("content-length", size);
    }
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/firebase-files/:blobId/content", async (req, res, next) => {
  try {
    const { buffer, metadata } = await getRealtimeDatabaseFileBlob(req.params.blobId);
    const size = buffer.length;
    const range = String(req.headers.range || "");
    res.setHeader("content-type", metadata.mimeType || "application/octet-stream");
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("cache-control", "private, max-age=3600");
    if (range) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || end >= size || start > end) {
        res.status(416).setHeader("content-range", `bytes */${size}`).end();
        return;
      }
      res.status(206);
      res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
      res.setHeader("content-length", end - start + 1);
      res.end(buffer.subarray(start, end + 1));
      return;
    }
    res.setHeader("content-length", size);
    res.end(buffer);
  } catch (error) {
    next(error);
  }
});

app.get("/api/drive/folders/:folderId/files", async (req, res, next) => {
  try {
    res.json({ ok: true, files: await listEvaluationFolderFiles(req.params.folderId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/drive/files/:fileId/content", async (req, res, next) => {
  try {
    const fileId = String(req.params.fileId || "").trim();
    if (!fileId) {
      res.status(400).json({ ok: false, error: "fileId requerido." });
      return;
    }
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`, { headers });
    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).send(await upstream.text());
      return;
    }
    res.status(upstream.status);
    const passthroughHeaders = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"];
    passthroughHeaders.forEach(name => {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    });
    if (!res.getHeader("content-type")) res.setHeader("content-type", "audio/mpeg");
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("cache-control", "private, max-age=3600");
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    next(error);
  }
});

async function handleRpcRequest(req, res, next) {
  try {
    const functionName = req.params.functionName;
    const handler = gasHandlers[functionName];
    if (!handler) {
      res.status(404).json({ ok: false, error: `Funcion no disponible en backend Node: ${functionName}` });
      return;
    }
    const result = await handler(...(req.body?.args || []));
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
}

app.post("/api/rpc/:functionName", handleRpcRequest);
app.post("/api/gas/:functionName", handleRpcRequest);

app.use(express.static(publicDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error("[LOCAL_API_ERROR]", error);
  res.status(error.status || 500).json({
    ok: false,
    error: error.message || "Error inesperado en API local."
  });
});

app.listen(config.port, () => {
  console.log(`Calidad B2B local: http://localhost:${config.port}`);
});
