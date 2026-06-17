import { readSharedJson, writeSharedRecord } from "./firebase.js";

function extractBase64(file) {
  const raw = String(file?.base64 || file?.dataUrl || file?.audioDataUrl || file?.downloadDataUrl || "");
  if (!raw) return "";
  const commaIndex = raw.indexOf(",");
  return commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw;
}

function makeBlobId(ownerId, index) {
  const cleanOwner = String(ownerId || Date.now()).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return `${cleanOwner}_${Date.now()}_${index}_${Math.floor(Math.random() * 100000)}`;
}

function getBlobKey(blobId) {
  return `file_blob_${String(blobId || "").trim()}`;
}

function makeBlobMetadata(blobId, file, size) {
  const url = `/api/firebase-files/${encodeURIComponent(blobId)}/content`;
  return {
    id: blobId,
    blobId,
    fileId: "",
    storageProvider: "firebase_realtime_database",
    name: String(file?.name || "adjunto").trim(),
    mimeType: String(file?.mimeType || "application/octet-stream").trim(),
    url,
    publicUrl: url,
    downloadUrl: url,
    previewUrl: url,
    type: file?.kind || file?.type || "evaluation_attachment",
    size: Number(size || file?.size || 0) || 0,
    uploadedAt: new Date().toISOString(),
    source: "firebase_database_blob"
  };
}

export function isFirebaseBlobFile(file) {
  return String(file?.storageProvider || "").toLowerCase() === "firebase_realtime_database" || Boolean(file?.blobId);
}

export function getFirebaseBlobPlaybackUrl(file) {
  const blobId = String(file?.blobId || file?.id || "").trim();
  return blobId ? `/api/firebase-files/${encodeURIComponent(blobId)}/content` : "";
}

export async function uploadAttachmentsToRealtimeDatabase(owner, attachments = []) {
  const result = {
    ok: true,
    savedFiles: [],
    skippedAttachments: [],
    storageWarning: "",
    storageProvider: "firebase_realtime_database"
  };
  const files = Array.isArray(attachments) ? attachments : [];
  if (!files.length) return result;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file || !file.name) continue;
    try {
      const base64 = extractBase64(file);
      if (!base64) {
        const error = new Error("El adjunto no trae base64 para guardar en Firebase.");
        error.reason = "sin_base64_para_guardar";
        throw error;
      }
      const bufferSize = Buffer.byteLength(base64, "base64");
      const blobId = makeBlobId(owner?.idEvaluacion || owner?.id, index);
      await writeSharedRecord(getBlobKey(blobId), {
        id: blobId,
        ownerId: String(owner?.idEvaluacion || owner?.id || ""),
        advisorName: String(owner?.asesorNombre || owner?.assessor || ""),
        name: String(file.name || "adjunto").trim(),
        mimeType: String(file.mimeType || "application/octet-stream").trim(),
        type: file.kind || file.type || "evaluation_attachment",
        size: Number(file.size || bufferSize || 0) || 0,
        base64,
        createdAt: new Date().toISOString()
      });
      result.savedFiles.push(makeBlobMetadata(blobId, file, bufferSize));
    } catch (error) {
      result.ok = false;
      result.skippedAttachments.push({
        name: String(file?.name || ""),
        mimeType: String(file?.mimeType || ""),
        type: file?.kind || file?.type || "evaluation_attachment",
        size: Number(file?.size || 0) || 0,
        reason: error.reason || error.message || "firebase_database_blob_error"
      });
    }
  }
  if (!result.ok) result.storageWarning = "Algunos adjuntos no pudieron guardarse en Firebase Realtime Database.";
  return result;
}

export async function getRealtimeDatabaseFileBlob(blobId) {
  const cleanId = String(blobId || "").trim();
  if (!cleanId) throw new Error("blobId requerido.");
  const blob = await readSharedJson(getBlobKey(cleanId), null);
  if (!blob || !blob.base64) {
    const error = new Error("No se encontro el archivo solicitado en Firebase.");
    error.status = 404;
    throw error;
  }
  const buffer = Buffer.from(String(blob.base64 || ""), "base64");
  return {
    buffer,
    metadata: {
      id: cleanId,
      name: blob.name || "adjunto",
      mimeType: blob.mimeType || "application/octet-stream",
      size: Number(blob.size || buffer.length || 0) || buffer.length
    }
  };
}
