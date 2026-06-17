import fs from "node:fs";
import { Readable } from "node:stream";
import { google } from "googleapis";
import { config } from "./config.js";

const AUDIO_EXTENSIONS = /\.(mp3|mpeg|mpga|m4a|wav|ogg|webm)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp)$/i;

let driveClientPromise = null;

function sanitizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/:*?"<>|#%{}~&]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 120);
}

function normalizeAdvisorFolderName(value) {
  return sanitizeName(value).toUpperCase() || "Asesor sin nombre";
}

function getFileExtensionFromName(name, fallback) {
  const match = String(name || "").match(/(\.[A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : (fallback || "");
}

export function isEvaluationAudioFile(file) {
  const mimeType = String(file?.mimeType || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || file?.kind || "").toLowerCase();
  return mimeType.startsWith("audio/") || type.includes("audio") || AUDIO_EXTENSIONS.test(name);
}

export function isEvaluationImageFile(file) {
  const mimeType = String(file?.mimeType || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || file?.kind || "").toLowerCase();
  return mimeType.startsWith("image/") || type.includes("image") || IMAGE_EXTENSIONS.test(name);
}

function getEvaluationAttachmentFileName(file, evaluationId, index) {
  const kind = String(file?.kind || file?.type || "").toLowerCase();
  const mimeType = String(file?.mimeType || "").toLowerCase();
  const originalName = String(file?.name || "");
  const extension = getFileExtensionFromName(
    originalName,
    mimeType.includes("png") ? ".png" :
      mimeType.includes("jpeg") || mimeType.includes("jpg") ? ".jpg" :
        mimeType.includes("wav") ? ".wav" :
          mimeType.includes("mpeg") || mimeType.includes("mp3") ? ".mp3" :
            ""
  );
  const suffix = index ? `_${index + 1}` : "";
  if (kind.includes("audio") || mimeType.startsWith("audio/") || AUDIO_EXTENSIONS.test(originalName)) {
    return sanitizeName(`audio_llamada_${evaluationId}${suffix}`) + extension;
  }
  if (kind.includes("image") || mimeType.startsWith("image/") || IMAGE_EXTENSIONS.test(originalName)) {
    return sanitizeName(`imagen_evidencia_${evaluationId}${suffix}`) + extension;
  }
  return sanitizeName(`adjunto_${evaluationId}${suffix}_${originalName || "archivo"}`);
}

function extractBase64(file) {
  const raw = String(file?.base64 || file?.dataUrl || file?.audioDataUrl || file?.downloadDataUrl || "");
  if (!raw) return "";
  const commaIndex = raw.indexOf(",");
  return commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw;
}

async function getDriveClient() {
  if (driveClientPromise) return driveClientPromise;
  driveClientPromise = (async () => {
    if (!config.googleCredentials && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new Error("Drive no esta configurado. Define GOOGLE_APPLICATION_CREDENTIALS en .env.");
    }
    if (config.googleCredentials && !fs.existsSync(config.googleCredentials)) {
      throw new Error(`No existe el archivo GOOGLE_APPLICATION_CREDENTIALS: ${config.googleCredentials}`);
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: config.googleCredentials || undefined,
      scopes: ["https://www.googleapis.com/auth/drive"]
    });
    return google.drive({ version: "v3", auth });
  })();
  return driveClientPromise;
}

async function findChildFolder(drive, parentId, folderName) {
  const escapedName = String(folderName || "").replace(/'/g, "\\'");
  const response = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and trashed = false`,
    fields: "files(id,name,webViewLink)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  return response.data.files?.[0] || null;
}

async function getOrCreateChildFolder(drive, parentId, folderName) {
  const safeName = sanitizeName(folderName) || "Sin nombre";
  const existing = await findChildFolder(drive, parentId, safeName);
  if (existing) return existing;
  const response = await drive.files.create({
    requestBody: {
      name: safeName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId]
    },
    fields: "id,name,webViewLink",
    supportsAllDrives: true
  });
  return response.data;
}

async function getOrCreateEvaluationFolderForAdvisor(drive, evaluation) {
  if (!config.driveRootFolderId) {
    throw new Error("Falta GOOGLE_DRIVE_ROOT_FOLDER_ID en .env.");
  }
  const advisorFolder = await getOrCreateChildFolder(drive, config.driveRootFolderId, normalizeAdvisorFolderName(evaluation?.asesorNombre));
  const evaluationFolder = await getOrCreateChildFolder(drive, advisorFolder.id, `evaluacion_${evaluation?.id}`);
  return { advisorFolder, evaluationFolder };
}

async function findFileByNameInFolder(drive, folderId, fileName) {
  const escapedName = String(fileName || "").replace(/'/g, "\\'");
  const response = await drive.files.list({
    q: `'${folderId}' in parents and name = '${escapedName}' and trashed = false`,
    fields: "files(id,name,mimeType,size,webViewLink,createdTime,modifiedTime)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  return response.data.files?.[0] || null;
}

async function makeDriveFilePublic(drive, fileId) {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
      supportsAllDrives: true
    });
  } catch (error) {
    if (!String(error?.message || "").includes("already exists")) {
      console.warn("[DRIVE_PERMISSION_WARNING]", fileId, error.message);
    }
  }
}

function makeEvaluationDriveFileMetadata(file, kind, source = "drive_upload") {
  const id = file.id || file.fileId || "";
  return {
    id,
    fileId: id,
    name: file.name || "",
    mimeType: file.mimeType || "",
    url: file.webViewLink || `https://drive.google.com/file/d/${id}/view`,
    publicUrl: `https://drive.google.com/uc?export=download&id=${id}`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${id}`,
    previewUrl: `https://drive.google.com/file/d/${id}/preview`,
    type: kind || "evaluation_attachment",
    size: Number(file.size || 0) || 0,
    uploadedAt: new Date().toISOString(),
    source
  };
}

async function uploadOneAttachment(drive, folderId, evaluation, file, index) {
  const fileName = getEvaluationAttachmentFileName(file, evaluation.id, index);
  const existing = await findFileByNameInFolder(drive, folderId, fileName);
  if (existing) {
    await makeDriveFilePublic(drive, existing.id);
    return makeEvaluationDriveFileMetadata(existing, file.kind || file.type || "evaluation_attachment", "drive_reused");
  }

  const base64 = extractBase64(file);
  if (!base64) {
    const error = new Error("El adjunto no trae base64 para subir a Drive.");
    error.reason = "sin_base64_para_subir";
    throw error;
  }

  const buffer = Buffer.from(base64, "base64");
  const mimeType = file.mimeType || "application/octet-stream";
  const response = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: {
      mimeType,
      body: Readable.from(buffer)
    },
    fields: "id,name,mimeType,size,webViewLink,createdTime,modifiedTime",
    supportsAllDrives: true
  });
  await makeDriveFilePublic(drive, response.data.id);
  return makeEvaluationDriveFileMetadata(response.data, file.kind || file.type || "evaluation_attachment");
}

export async function listEvaluationFolderFiles(folderId) {
  const cleanFolderId = String(folderId || "").trim();
  if (!cleanFolderId) return [];
  const drive = await getDriveClient();
  const response = await drive.files.list({
    q: `'${cleanFolderId}' in parents and trashed = false`,
    fields: "files(id,name,mimeType,size,webViewLink,createdTime,modifiedTime)",
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  const files = response.data.files || [];
  await Promise.all(files.map(file => makeDriveFilePublic(drive, file.id)));
  return files.map(file => makeEvaluationDriveFileMetadata(
    file,
    isEvaluationAudioFile(file) ? "evaluation_audio" : isEvaluationImageFile(file) ? "evaluation_image" : "evaluation_attachment",
    "drive_folder_scan"
  ));
}

export async function enrichEvaluationWithDirectDriveFolder(evaluation) {
  if (!evaluation || typeof evaluation !== "object") return evaluation;
  const folderId = String(evaluation.driveFolderEvaluacionId || evaluation.driveFolderId || "").trim();
  if (!folderId) return evaluation;
  try {
    const existingFiles = Array.isArray(evaluation.files) ? evaluation.files.slice() : [];
    const seen = new Set(existingFiles.map(file => String(file?.id || file?.fileId || "").trim()).filter(Boolean));
    const driveFiles = await listEvaluationFolderFiles(folderId);
    for (const file of driveFiles) {
      const id = String(file?.id || file?.fileId || "").trim();
      if (id && !seen.has(id)) {
        existingFiles.push(file);
        seen.add(id);
      }
    }
    const audioFile = existingFiles.find(isEvaluationAudioFile) || {};
    const imageFile = existingFiles.find(isEvaluationImageFile) || {};
    return {
      ...evaluation,
      files: existingFiles,
      externalDriveMatches: driveFiles.length,
      audioLlamadaId: evaluation.audioLlamadaId || audioFile.id || audioFile.fileId || "",
      audioLlamadaUrl: evaluation.audioLlamadaUrl || audioFile.publicUrl || audioFile.url || "",
      nombreArchivoAudio: evaluation.nombreArchivoAudio || audioFile.name || "",
      imagenEvidenciaId: evaluation.imagenEvidenciaId || imageFile.id || imageFile.fileId || "",
      imagenEvidenciaUrl: evaluation.imagenEvidenciaUrl || imageFile.publicUrl || imageFile.url || "",
      nombreArchivoImagen: evaluation.nombreArchivoImagen || imageFile.name || "",
      estadoAdjuntos: evaluation.estadoAdjuntos || (existingFiles.length ? "completo" : "")
    };
  } catch (error) {
    console.warn("[DRIVE_DIRECT_DETAIL_ERROR]", folderId, error.message);
    return evaluation;
  }
}

export async function uploadEvaluationAttachmentsToDrive(evaluation, attachments = []) {
  const result = {
    ok: true,
    savedFiles: [],
    skippedAttachments: [],
    driveWarning: "",
    driveFolderAsesorId: "",
    driveFolderAsesorUrl: "",
    driveFolderEvaluacionId: "",
    driveFolderEvaluacionUrl: ""
  };
  const files = Array.isArray(attachments) ? attachments : [];
  if (!files.length) return result;

  try {
    const drive = await getDriveClient();
    const folderInfo = await getOrCreateEvaluationFolderForAdvisor(drive, evaluation);
    result.driveFolderAsesorId = folderInfo.advisorFolder.id;
    result.driveFolderAsesorUrl = folderInfo.advisorFolder.webViewLink || `https://drive.google.com/drive/folders/${folderInfo.advisorFolder.id}`;
    result.driveFolderEvaluacionId = folderInfo.evaluationFolder.id;
    result.driveFolderEvaluacionUrl = folderInfo.evaluationFolder.webViewLink || `https://drive.google.com/drive/folders/${folderInfo.evaluationFolder.id}`;

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!file || !file.name) continue;
      try {
        result.savedFiles.push(await uploadOneAttachment(drive, folderInfo.evaluationFolder.id, evaluation, file, index));
      } catch (error) {
        result.ok = false;
        result.skippedAttachments.push({
          name: String(file?.name || ""),
          mimeType: String(file?.mimeType || ""),
          type: file?.kind || file?.type || "evaluation_attachment",
          size: Number(file?.size || 0) || 0,
          reason: error.reason || error.message || "drive_upload_error"
        });
      }
    }
    if (!result.ok) {
      result.driveWarning = "Algunos adjuntos no pudieron subirse a Drive.";
    }
    return result;
  } catch (error) {
    return {
      ...result,
      ok: false,
      driveWarning: error.message || "No se pudieron guardar adjuntos en Drive.",
      skippedAttachments: files.map(file => ({
        name: file?.name || "",
        mimeType: file?.mimeType || "",
        type: file?.kind || file?.type || "evaluation_attachment",
        size: Number(file?.size || 0) || 0,
        reason: error.message || "drive_no_configurado"
      }))
    };
  }
}

export async function validateDriveConnection() {
  const status = {
    ok: false,
    configured: Boolean(config.googleCredentials || process.env.GOOGLE_APPLICATION_CREDENTIALS),
    rootFolderId: config.driveRootFolderId,
    rootFolderAccessible: false,
    canList: false,
    error: ""
  };
  try {
    const drive = await getDriveClient();
    const folder = await drive.files.get({
      fileId: config.driveRootFolderId,
      fields: "id,name,mimeType,webViewLink",
      supportsAllDrives: true
    });
    status.rootFolderAccessible = Boolean(folder.data?.id);
    const list = await drive.files.list({
      q: `'${config.driveRootFolderId}' in parents and trashed = false`,
      fields: "files(id,name,mimeType)",
      pageSize: 5,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    status.canList = Array.isArray(list.data.files);
    status.ok = status.rootFolderAccessible && status.canList;
    status.rootFolderName = folder.data?.name || "";
    status.sampleCount = list.data.files?.length || 0;
    return status;
  } catch (error) {
    status.error = error.message || String(error);
    return status;
  }
}
