import fs from "node:fs";
import { Storage } from "@google-cloud/storage";
import { config } from "./config.js";
import { isEvaluationAudioFile, isEvaluationImageFile } from "./drive.js";

const AUDIO_EXTENSIONS = /\.(mp3|mpeg|mpga|m4a|wav|ogg|webm)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp)$/i;

let storageClientPromise = null;
let bucketNamePromise = null;

function sanitizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/:*?"<>|#%{}~&]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 140);
}

function extractBase64(file) {
  const raw = String(file?.base64 || file?.dataUrl || file?.audioDataUrl || file?.downloadDataUrl || "");
  if (!raw) return "";
  const commaIndex = raw.indexOf(",");
  return commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw;
}

function getCredentials() {
  if (config.googleCredentialsJson) return JSON.parse(config.googleCredentialsJson);
  if (config.googleCredentials && fs.existsSync(config.googleCredentials)) {
    return JSON.parse(fs.readFileSync(config.googleCredentials, "utf8"));
  }
  return null;
}

async function getStorageClient() {
  if (storageClientPromise) return storageClientPromise;
  storageClientPromise = (async () => {
    const credentials = getCredentials();
    if (!credentials && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new Error("Firebase Storage no esta configurado. Define GOOGLE_CREDENTIALS_JSON o GOOGLE_APPLICATION_CREDENTIALS.");
    }
    return new Storage({
      credentials: credentials || undefined,
      projectId: credentials?.project_id || undefined,
      keyFilename: !credentials && config.googleCredentials ? config.googleCredentials : undefined
    });
  })();
  return storageClientPromise;
}

async function getBucketName() {
  if (bucketNamePromise) return bucketNamePromise;
  bucketNamePromise = (async () => {
    if (config.firebaseStorageBucket) return config.firebaseStorageBucket;
    const credentials = getCredentials();
    if (!credentials?.project_id) {
      throw new Error("Falta FIREBASE_STORAGE_BUCKET y no se pudo inferir el project_id.");
    }
    return `${credentials.project_id}.appspot.com`;
  })();
  return bucketNamePromise;
}

function getFileExtensionFromName(name, fallback) {
  const match = String(name || "").match(/(\.[A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : (fallback || "");
}

function getAttachmentFileName(file, ownerId, index) {
  const kind = String(file?.kind || file?.type || "").toLowerCase();
  const mimeType = String(file?.mimeType || "").toLowerCase();
  const originalName = String(file?.name || "");
  const extension = getFileExtensionFromName(
    originalName,
    mimeType.includes("png") ? ".png" :
      mimeType.includes("jpeg") || mimeType.includes("jpg") ? ".jpg" :
        mimeType.includes("wav") ? ".wav" :
          mimeType.includes("mpeg") || mimeType.includes("mp3") ? ".mp3" :
            mimeType.includes("pdf") ? ".pdf" :
              ""
  );
  const suffix = index ? `_${index + 1}` : "";
  if (kind.includes("audio") || mimeType.startsWith("audio/") || AUDIO_EXTENSIONS.test(originalName)) {
    return sanitizeName(`audio_llamada_${ownerId}${suffix}`) + extension;
  }
  if (kind.includes("image") || mimeType.startsWith("image/") || IMAGE_EXTENSIONS.test(originalName)) {
    return sanitizeName(`imagen_evidencia_${ownerId}${suffix}`) + extension;
  }
  return sanitizeName(`adjunto_${ownerId}${suffix}_${originalName || "archivo"}`);
}

function normalizeStorageMimeType(file) {
  const rawMime = String(file?.mimeType || "").trim();
  const mimeType = rawMime.toLowerCase();
  const originalName = String(file?.name || "").toLowerCase();
  const kind = String(file?.kind || file?.type || "").toLowerCase();
  const isAudio = kind.includes("audio") || mimeType.startsWith("audio/") || AUDIO_EXTENSIONS.test(originalName);
  if (!isAudio) return rawMime || "application/octet-stream";
  if (originalName.endsWith(".m4a")) return "audio/mp4";
  if (originalName.endsWith(".wav")) return "audio/wav";
  if (originalName.endsWith(".ogg")) return "audio/ogg";
  if (originalName.endsWith(".webm")) return "audio/webm";
  if (mimeType === "video/mpeg" || mimeType === "application/octet-stream" || mimeType === "") return "audio/mpeg";
  return mimeType.startsWith("audio/") ? rawMime : "audio/mpeg";
}

function getOwnerFolder(evaluation) {
  const advisor = sanitizeName(evaluation?.asesorNombre || evaluation?.assessor || "asesor_sin_nombre").toUpperCase();
  const id = sanitizeName(evaluation?.idEvaluacion || evaluation?.id || Date.now());
  return `calidad-b2b/${advisor}/${id}`;
}

function makeStorageFileMetadata(storagePath, fileName, mimeType, kind, size) {
  const encodedPath = encodeURIComponent(storagePath);
  const contentUrl = `/api/storage/files/${encodedPath}/content`;
  return {
    id: storagePath,
    fileId: "",
    storagePath,
    storageProvider: "firebase_storage",
    bucket: config.firebaseStorageBucket || "",
    name: fileName,
    mimeType: mimeType || "application/octet-stream",
    url: contentUrl,
    publicUrl: contentUrl,
    downloadUrl: contentUrl,
    previewUrl: contentUrl,
    type: kind || "evaluation_attachment",
    size: Number(size || 0) || 0,
    uploadedAt: new Date().toISOString(),
    source: "firebase_storage_upload"
  };
}

export function isFirebaseStorageFile(file) {
  return String(file?.storageProvider || "").toLowerCase() === "firebase_storage" || Boolean(file?.storagePath);
}

export function getFirebaseStoragePlaybackUrl(file) {
  const storagePath = String(file?.storagePath || "").trim();
  return storagePath ? `/api/storage/files/${encodeURIComponent(storagePath)}/content` : "";
}

export async function uploadAttachmentsToFirebaseStorage(evaluation, attachments = []) {
  const result = {
    ok: true,
    savedFiles: [],
    skippedAttachments: [],
    storageWarning: "",
    storageBucket: "",
    storageFolder: ""
  };
  const files = Array.isArray(attachments) ? attachments : [];
  if (!files.length) return result;

  try {
    const storage = await getStorageClient();
    const bucketName = await getBucketName();
    const bucket = storage.bucket(bucketName);
    result.storageBucket = bucketName;
    result.storageFolder = getOwnerFolder(evaluation);

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!file || !file.name) continue;
      try {
        const base64 = extractBase64(file);
        if (!base64) {
          const error = new Error("El adjunto no trae base64 para subir a Firebase Storage.");
          error.reason = "sin_base64_para_subir";
          throw error;
        }
        const buffer = Buffer.from(base64, "base64");
        const mimeType = normalizeStorageMimeType(file);
        const fileName = getAttachmentFileName(file, evaluation?.idEvaluacion || evaluation?.id || Date.now(), index);
        const storagePath = `${result.storageFolder}/${fileName}`;
        await bucket.file(storagePath).save(buffer, {
          resumable: false,
          contentType: mimeType,
          metadata: {
            contentType: mimeType,
            cacheControl: "private, max-age=3600",
            metadata: {
              sourceApp: "calidad-b2b",
              ownerId: String(evaluation?.idEvaluacion || evaluation?.id || ""),
              advisorName: String(evaluation?.asesorNombre || evaluation?.assessor || "")
            }
          }
        });
        result.savedFiles.push(makeStorageFileMetadata(storagePath, fileName, mimeType, file.kind || file.type || "evaluation_attachment", buffer.length));
      } catch (error) {
        result.ok = false;
        result.skippedAttachments.push({
          name: String(file?.name || ""),
          mimeType: String(file?.mimeType || ""),
          type: file?.kind || file?.type || "evaluation_attachment",
          size: Number(file?.size || 0) || 0,
          reason: error.reason || error.message || "firebase_storage_upload_error"
        });
      }
    }
    if (!result.ok) result.storageWarning = "Algunos adjuntos no pudieron subirse a Firebase Storage.";
    return result;
  } catch (error) {
    return {
      ...result,
      ok: false,
      storageWarning: error.message || "No se pudieron guardar adjuntos en Firebase Storage.",
      skippedAttachments: files.map(file => ({
        name: file?.name || "",
        mimeType: file?.mimeType || "",
        type: file?.kind || file?.type || "evaluation_attachment",
        size: Number(file?.size || 0) || 0,
        reason: error.message || "firebase_storage_no_configurado"
      }))
    };
  }
}

export async function getFirebaseStorageFileStream(storagePath, rangeHeader = "") {
  const cleanPath = String(storagePath || "").trim();
  if (!cleanPath) throw new Error("storagePath requerido.");
  const storage = await getStorageClient();
  const bucketName = await getBucketName();
  const file = storage.bucket(bucketName).file(cleanPath);
  const [metadata] = await file.getMetadata();
  const options = {};
  if (rangeHeader) {
    const match = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
    if (match) {
      if (match[1]) options.start = Number(match[1]);
      if (match[2]) options.end = Number(match[2]);
    }
  }
  return {
    stream: file.createReadStream(options),
    metadata,
    status: options.start !== undefined || options.end !== undefined ? 206 : 200
  };
}

export async function validateFirebaseStorageConnection() {
  const status = {
    ok: false,
    configured: Boolean(config.firebaseStorageBucket || config.googleCredentials || config.googleCredentialsJson || process.env.GOOGLE_APPLICATION_CREDENTIALS),
    bucket: config.firebaseStorageBucket || "",
    canAccess: false,
    error: ""
  };
  try {
    const storage = await getStorageClient();
    const bucketName = await getBucketName();
    status.bucket = bucketName;
    const [exists] = await storage.bucket(bucketName).exists();
    status.canAccess = exists;
    status.ok = exists;
    return status;
  } catch (error) {
    status.error = error.message || String(error);
    return status;
  }
}

export function splitFilesByStorageKind(files) {
  const list = Array.isArray(files) ? files : [];
  return {
    audioFile: list.find(isEvaluationAudioFile) || {},
    imageFile: list.find(isEvaluationImageFile) || {}
  };
}
