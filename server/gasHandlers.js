import {
  deleteSharedRecord,
  getEvaluationRecordKey,
  listSharedKeys,
  normalizeId,
  readSharedJson,
  readSharedRecord,
  writeSharedRecord
} from "./firebase.js";
import {
  getFirebaseBlobPlaybackUrl,
  isFirebaseBlobFile,
  uploadAttachmentsToRealtimeDatabase
} from "./fileBlobs.js";
import {
  enrichEvaluationWithDirectDriveFolder,
  isEvaluationAudioFile,
  isEvaluationImageFile,
  validateDriveConnection
} from "./drive.js";
import {
  getFirebaseStoragePlaybackUrl,
  isFirebaseStorageFile,
  uploadAttachmentsToFirebaseStorage,
  validateFirebaseStorageConnection
} from "./storage.js";

const EVALUATIONS_KEY = "evaluations_v1";
const DELETED_EVALUATIONS_KEY = "deleted_evaluations_v1";
const COMMUNICATIONS_KEY = "communications_v1";
const FEEDBACK_KEY = "feedback_records_v2";
const evaluationWriteLocks = new Map();

const ROLE_LABELS = {
  admin: "Administrador",
  analista: "Analista",
  supervisor: "Supervisor",
  formador: "Formador",
  asesor: "Asesor"
};

function nowIso() {
  return new Date().toISOString();
}

function generateNumericId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

function normalizeDateOrNow(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? nowIso() : date.toISOString();
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
}

function getRole(user) {
  const role = normalizeText(user?.rol || user?.role || "");
  const aliases = {
    administrador: "admin",
    administration: "admin",
    administrator: "admin",
    monitor: "analista",
    analyst: "analista",
    trainer: "formador",
    coach: "formador",
    advisor: "asesor"
  };
  return aliases[role] || role;
}

function ensureCurrentUser(user) {
  if (!user || typeof user !== "object" || !String(user.usuario || "").trim()) {
    throw new Error("No se pudo validar el usuario actual.");
  }
  return user;
}

function requireRoles(user, roles, message) {
  const role = getRole(user);
  if (!roles.includes(role)) throw new Error(message || "No tienes permisos para realizar esta accion.");
}

function canManageCommunications(user) {
  return ["admin", "analista", "supervisor", "formador"].includes(getRole(user));
}

function getCommunicationAudienceRoles(audienceValue) {
  const audience = normalizeText(audienceValue);
  if (audience === "staff") return ["admin", "analista", "supervisor", "formador"];
  if (audience === "asesores" || audience === "todos") return ["admin", "analista", "supervisor", "formador", "asesor"];
  return [];
}

function canUserViewCommunication(user, communication) {
  return getCommunicationAudienceRoles(communication?.publicoObjetivo).includes(getRole(user));
}

function isCommunicationExpired(communication) {
  const value = String(communication?.fechaVencimiento || "").trim();
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
}

function enrichCommunicationForUser(communication, user) {
  const userId = normalizeText(user?.usuario || "");
  const readEntries = Array.isArray(communication?.leidosPor) ? communication.leidosPor : [];
  const comments = Array.isArray(communication?.comentarios) ? communication.comentarios : [];
  return {
    ...communication,
    isExpired: isCommunicationExpired(communication),
    readCount: readEntries.length,
    commentCount: comments.length,
    userHasRead: readEntries.some(item => normalizeText(item?.usuario) === userId)
  };
}

async function readCommunications() {
  const records = await readSharedJson(COMMUNICATIONS_KEY, []);
  return Array.isArray(records) ? records : [];
}

async function writeCommunications(records) {
  await writeSharedRecord(COMMUNICATIONS_KEY, Array.isArray(records) ? records : []);
}

function sortCommunications(records) {
  const priorityOrder = { alta: 3, media: 2, baja: 1 };
  return records.sort((a, b) => {
    const pinnedDiff = Number(Boolean(b?.fijado)) - Number(Boolean(a?.fijado));
    if (pinnedDiff) return pinnedDiff;
    const priorityDiff = (priorityOrder[normalizeText(b?.prioridad)] || 0) - (priorityOrder[normalizeText(a?.prioridad)] || 0);
    if (priorityDiff) return priorityDiff;
    return new Date(b?.fechaPublicacion || b?.fechaCreacion || 0).getTime() - new Date(a?.fechaPublicacion || a?.fechaCreacion || 0).getTime();
  });
}

async function findCommunicationFileById(fileId) {
  const id = String(fileId || "").trim();
  if (!id) return null;
  const records = await readCommunications();
  for (const record of records) {
    const files = Array.isArray(record?.files) ? record.files : [];
    const match = files.find(file => String(file?.id || file?.fileId || "").trim() === id);
    if (match) return match;
  }
  return { id, fileId: id, name: "Adjunto de comunicado", mimeType: "application/octet-stream" };
}

function buildLocalDrivePreview(file) {
  if (isFirebaseBlobFile(file)) {
    const blobId = String(file?.blobId || file?.id || "").trim();
    if (!blobId) throw new Error("El blobId es obligatorio.");
    const localUrl = getFirebaseBlobPlaybackUrl({ blobId });
    const mimeType = String(file?.mimeType || "").toLowerCase();
    const name = String(file?.name || "Adjunto").trim();
    const isTextFile = mimeType === "text/plain" || /\.txt$/i.test(name);
    const isAudioFile = mimeType.startsWith("audio/") || /\.(mp3|mpeg|mpga|m4a|wav|ogg|webm)$/i.test(name);
    const isImageFile = mimeType.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
    const isPdfFile = mimeType === "application/pdf" || /\.pdf$/i.test(name);
    return {
      id: blobId,
      blobId,
      storageProvider: "firebase_realtime_database",
      name,
      mimeType: file?.mimeType || (isAudioFile ? "audio/mpeg" : isImageFile ? "image/png" : "application/octet-stream"),
      driveUrl: "",
      previewUrl: localUrl,
      downloadUrl: localUrl,
      downloadDataUrl: "",
      dataUrl: "",
      textContent: "",
      isTextFile,
      isAudioFile,
      isImageFile,
      isPdfFile,
      hideDriveLink: true
    };
  }
  if (isFirebaseStorageFile(file)) {
    const storagePath = String(file?.storagePath || file?.id || "").trim();
    if (!storagePath) throw new Error("El storagePath es obligatorio.");
    const localUrl = getFirebaseStoragePlaybackUrl({ storagePath });
    const mimeType = String(file?.mimeType || "").toLowerCase();
    const name = String(file?.name || "Adjunto").trim();
    const isTextFile = mimeType === "text/plain" || /\.txt$/i.test(name);
    const isAudioFile = mimeType.startsWith("audio/") || /\.(mp3|mpeg|mpga|m4a|wav|ogg|webm)$/i.test(name);
    const isImageFile = mimeType.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
    const isPdfFile = mimeType === "application/pdf" || /\.pdf$/i.test(name);
    return {
      id: storagePath,
      storagePath,
      storageProvider: "firebase_storage",
      name,
      mimeType: file?.mimeType || (isAudioFile ? "audio/mpeg" : isImageFile ? "image/png" : "application/octet-stream"),
      driveUrl: "",
      previewUrl: localUrl,
      downloadUrl: localUrl,
      downloadDataUrl: "",
      dataUrl: "",
      textContent: "",
      isTextFile,
      isAudioFile,
      isImageFile,
      isPdfFile,
      hideDriveLink: true
    };
  }
  const id = String(file?.id || file?.fileId || "").trim();
  if (!id) throw new Error("El fileId es obligatorio.");
  const mimeType = String(file?.mimeType || "").toLowerCase();
  const name = String(file?.name || "Adjunto").trim();
  const localUrl = `/api/drive/files/${encodeURIComponent(id)}/content`;
  const isTextFile = mimeType === "text/plain" || /\.txt$/i.test(name);
  const isAudioFile = mimeType.startsWith("audio/") || /\.(mp3|mpeg|mpga|m4a|wav|ogg|webm)$/i.test(name);
  const isImageFile = mimeType.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
  const isPdfFile = mimeType === "application/pdf" || /\.pdf$/i.test(name);
  return {
    id,
    name,
    mimeType: file?.mimeType || (isAudioFile ? "audio/mpeg" : isImageFile ? "image/png" : "application/octet-stream"),
    driveUrl: file?.url || file?.driveUrl || `https://drive.google.com/file/d/${id}/view`,
    previewUrl: localUrl,
    downloadUrl: localUrl,
    downloadDataUrl: "",
    dataUrl: "",
    textContent: "",
    isTextFile,
    isAudioFile,
    isImageFile,
    isPdfFile,
    hideDriveLink: false
  };
}

function upsertById(records, record) {
  const id = normalizeId(record?.id || record?.idEvaluacion);
  const list = Array.isArray(records) ? records.slice() : [];
  const index = list.findIndex(item => normalizeId(item?.id || item?.idEvaluacion) === id);
  if (index >= 0) list[index] = { ...list[index], ...record };
  else list.unshift(record);
  return list;
}

async function readFeedbackRecords() {
  const records = await readSharedJson(FEEDBACK_KEY, []);
  return Array.isArray(records) ? records : [];
}

async function writeFeedbackRecords(records) {
  await writeSharedRecord(FEEDBACK_KEY, Array.isArray(records) ? records : []);
}

function sortFeedbackRecords(records) {
  return records.sort((a, b) => (
    new Date(b?.feedbackDate || b?.updatedAt || b?.createdAt || 0).getTime() -
    new Date(a?.feedbackDate || a?.updatedAt || a?.createdAt || 0).getTime()
  ));
}

async function findFeedbackFileById(fileId) {
  const id = String(fileId || "").trim();
  if (!id) return null;
  const records = await readFeedbackRecords();
  for (const record of records) {
    const files = Array.isArray(record?.files) ? record.files : [];
    const match = files.find(file => String(file?.id || file?.fileId || "").trim() === id);
    if (match) return match;
  }
  return { id, fileId: id, name: "Adjunto de feedback", mimeType: "application/octet-stream" };
}

function appendFeedbackThreadMessage(record, message) {
  if (!Array.isArray(record.messages)) record.messages = [];
  record.messages.push({
    id: generateNumericId(),
    text: String(message?.text || "").trim(),
    authorName: String(message?.authorName || "").trim(),
    authorUser: String(message?.authorUser || "").trim(),
    authorRole: String(message?.authorRole || "").trim(),
    createdAt: nowIso()
  });
}

function normalizeFeedbackStatusForSave(advisorUser) {
  return String(advisorUser || "").trim() ? "pending" : "unassigned";
}

function canManageFeedback(user) {
  return ["admin", "analista", "supervisor", "formador"].includes(getRole(user));
}

function isFeedbackAdvisorValidated(record = {}) {
  const validation = normalizeText(record.advisorValidationStatus || record.advisorDecision || "");
  const status = normalizeText(record.estado || record.status || "");
  return ["accepted", "rejected", "advisor accepted", "advisor rejected", "advisor_accepted", "advisor_rejected"].includes(validation) ||
    ["accepted", "rejected", "advisor accepted", "advisor rejected", "advisor_accepted", "advisor_rejected"].includes(status) ||
    !!record.advisorValidatedAt ||
    !!record.advisorAcceptedAt;
}

function sanitizeRuntimePayload(payload = {}) {
  const { attachments, currentUser, attachment, attachmentMetadata, ...rest } = payload;
  return rest;
}

const DEFAULT_EVALUATION_SECTIONS = [
  { categoria: "1. Protocolo de Inicio", pesoItem: 5, nombreSeccion: "1.1 Presentacion", criterio: "Identificacion, empresa y motivo del contacto", pesoSub: 2.5, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 },
  { categoria: "1. Protocolo de Inicio", pesoItem: 5, nombreSeccion: "1.2 Validacion", criterio: "Validacion correcta del cliente y datos base", pesoSub: 2.5, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 },
  { categoria: "2. Habilidad Comercial", pesoItem: 30, nombreSeccion: "2.1 Sondeo estrategico", criterio: "Identificacion de necesidad y contexto comercial", pesoSub: 10, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 },
  { categoria: "2. Habilidad Comercial", pesoItem: 30, nombreSeccion: "2.2 Posicionamiento de valor", criterio: "Presentacion de beneficios y propuesta de valor", pesoSub: 10, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 },
  { categoria: "2. Habilidad Comercial", pesoItem: 30, nombreSeccion: "2.3 Manejo de objeciones", criterio: "Respuesta estructurada frente a dudas o barreras", pesoSub: 10, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 },
  { categoria: "3. Informacion Correcta y Completa", pesoItem: 35, nombreSeccion: "3.1 Transparencia de la oferta", criterio: "Explicacion clara de precios, condiciones y vigencia", pesoSub: 15, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 },
  { categoria: "3. Informacion Correcta y Completa", pesoItem: 35, nombreSeccion: "3.2 Control de Riesgo Comercial", criterio: "Validaciones para evitar errores o reclamos", pesoSub: 10, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 },
  { categoria: "3. Informacion Correcta y Completa", pesoItem: 35, nombreSeccion: "3.3 Procesos y plazos", criterio: "Informacion sobre pasos, tiempos y condiciones", pesoSub: 10, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 },
  { categoria: "4. Experiencia del Cliente", pesoItem: 10, nombreSeccion: "4.1 Escucha activa y empatia", criterio: "Comprension del cliente y respuesta empatica", pesoSub: 5, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 },
  { categoria: "4. Experiencia del Cliente", pesoItem: 10, nombreSeccion: "4.2 Profesionalismo y claridad", criterio: "Seguridad, orden y claridad al comunicar", pesoSub: 5, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 },
  { categoria: "5. Cumplimiento y Cierre de Venta", pesoItem: 20, nombreSeccion: "5.1 Cierre de ventas", criterio: "Validacion final y concrecion del cierre", pesoSub: 10, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 },
  { categoria: "5. Cumplimiento y Cierre de Venta", pesoItem: 20, nombreSeccion: "5.2 Script de verificacion", criterio: "Uso correcto del script obligatorio", pesoSub: 5, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 },
  { categoria: "5. Cumplimiento y Cierre de Venta", pesoItem: 20, nombreSeccion: "5.3 Tipificacion y sistemas", criterio: "Registro correcto y trazabilidad de la gestion", pesoSub: 5, resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0 }
];

function getEvaluationItemIdentityValues(item = {}) {
  return [
    item.nombreSeccion,
    item.subItem,
    item.item,
    item.itemCalidad,
    item.atributo,
    item.atributoCalidad,
    item.nombreAtributo,
    item.pregunta,
    item.criterio,
    item.factor,
    item.dimension
  ].map(value => normalizeText(value)).filter(Boolean);
}

function findMatchingEvaluationItem(items, templateItem) {
  const templateKeys = getEvaluationItemIdentityValues(templateItem);
  if (!Array.isArray(items) || !items.length || !templateKeys.length) return null;
  return items.find(item => {
    const itemKeys = getEvaluationItemIdentityValues(item);
    return itemKeys.some(itemKey => templateKeys.includes(itemKey));
  }) || null;
}

function normalizeEvaluationSections(sections) {
  const source = Array.isArray(sections) ? sections : [];
  return DEFAULT_EVALUATION_SECTIONS.map(templateSection => {
    const stored = findMatchingEvaluationItem(source, templateSection) || {};
    return {
      ...stored,
      categoria: templateSection.categoria,
      pesoItem: templateSection.pesoItem,
      nombreSeccion: templateSection.nombreSeccion,
      criterio: templateSection.criterio,
      pesoSub: templateSection.pesoSub,
      resultado: stored.resultado !== undefined ? stored.resultado : templateSection.resultado,
      detalleAuditado: stored.detalleAuditado || "",
      oportunidadMejora: stored.oportunidadMejora || "",
      evidencia: stored.evidencia || "",
      puntaje: stored.puntaje !== undefined ? stored.puntaje : templateSection.puntaje
    };
  });
}

function calculateEvaluationScore(sections) {
  let applicableWeight = 0;
  let achievedWeight = 0;
  for (const section of normalizeEvaluationSections(sections)) {
    const weight = Number(section.pesoSub || 0) || 0;
    const result = normalizeText(section.resultado);
    if (!weight || !result || result === "no aplica") continue;
    applicableWeight += weight;
    if (result === "cumple") achievedWeight += weight;
  }
  const pct = applicableWeight ? achievedWeight / applicableWeight * 100 : 0;
  const label = pct >= 90 ? "Excelente" : pct >= 80 ? "Cumple" : pct >= 60 ? "En seguimiento" : "Critico";
  return { applicableWeight, achievedWeight, pct, label, text: `${pct.toFixed(1)}% - ${label}` };
}

function normalizeEvaluationRecordForRuntime(record) {
  if (!record || typeof record !== "object" || !Array.isArray(record.secciones) || !record.secciones.length) return record;
  const secciones = normalizeEvaluationSections(record.secciones);
  const score = calculateEvaluationScore(secciones);
  const appliesCeroTolerancia = Boolean(record.appliesCeroTolerancia) ||
    (Array.isArray(record.zeroToleranceItems) && record.zeroToleranceItems.some(item => normalizeText(item?.resultado) === "cumple"));
  return {
    ...record,
    secciones,
    pesoAplicable: score.applicableWeight,
    puntajeLogrado: score.achievedWeight,
    resultadoGeneral: appliesCeroTolerancia ? "0.0% - Cero tolerancia" : score.text,
    appliesCeroTolerancia
  };
}

function buildFileFieldsFromSavedFiles(record, savedFiles, driveResult = {}) {
  const files = Array.isArray(savedFiles) ? savedFiles : [];
  const audioFile = files.find(isEvaluationAudioFile) || {};
  const imageFile = files.find(isEvaluationImageFile) || {};
  const storageFolder = driveResult.storageFolder || record.storageFolder || "";
  const storageBucket = driveResult.storageBucket || record.storageBucket || "";
  const warning = driveResult.storageWarning || driveResult.driveWarning || record.storageWarning || record.driveWarning || "";
  return {
    ...record,
    files,
    driveFolderAsesorId: driveResult.driveFolderAsesorId || record.driveFolderAsesorId || "",
    driveFolderAsesorUrl: driveResult.driveFolderAsesorUrl || record.driveFolderAsesorUrl || "",
    driveFolderEvaluacionId: driveResult.driveFolderEvaluacionId || record.driveFolderEvaluacionId || "",
    driveFolderEvaluacionUrl: driveResult.driveFolderEvaluacionUrl || record.driveFolderEvaluacionUrl || "",
    driveFolderId: driveResult.driveFolderEvaluacionId || record.driveFolderId || "",
    driveFolderUrl: driveResult.driveFolderEvaluacionUrl || record.driveFolderUrl || "",
    audioLlamadaId: audioFile.id || audioFile.fileId || record.audioLlamadaId || record.audioId || "",
    audioLlamadaUrl: audioFile.publicUrl || audioFile.url || record.audioLlamadaUrl || record.audioUrl || "",
    audioId: audioFile.id || audioFile.fileId || record.audioId || "",
    audioUrl: audioFile.publicUrl || audioFile.url || record.audioUrl || "",
    nombreArchivoAudio: audioFile.name || record.nombreArchivoAudio || "",
    imagenEvidenciaId: imageFile.id || imageFile.fileId || record.imagenEvidenciaId || "",
    imagenEvidenciaUrl: imageFile.publicUrl || imageFile.url || record.imagenEvidenciaUrl || "",
    nombreArchivoImagen: imageFile.name || record.nombreArchivoImagen || "",
    skippedAttachments: driveResult.skippedAttachments || record.skippedAttachments || [],
    driveWarning: driveResult.driveWarning || record.driveWarning || "",
    storageWarning: driveResult.storageWarning || record.storageWarning || "",
    storageFolder,
    storageBucket,
    attachmentStorageProvider: storageFolder ? "firebase_storage" : (record.attachmentStorageProvider || ""),
    uploadWarning: warning
  };
}

function mergeFilesByIdentity(...fileGroups) {
  const merged = [];
  const seen = new Set();
  for (const group of fileGroups) {
    for (const file of Array.isArray(group) ? group : []) {
      if (!file) continue;
      const key = String(file.blobId || file.storagePath || file.id || file.fileId || file.url || file.publicUrl || file.name || "").trim();
      const fallbackKey = JSON.stringify({
        name: file.name || "",
        mimeType: file.mimeType || "",
        size: file.size || "",
        type: file.type || file.kind || ""
      });
      const identity = key || fallbackKey;
      if (seen.has(identity)) continue;
      seen.add(identity);
      merged.push(file);
    }
  }
  return merged;
}

function getSkippedAttachmentKey(file) {
  return [
    String(file?.name || "").trim(),
    String(file?.mimeType || "").trim(),
    String(file?.size || "").trim(),
    String(file?.type || file?.kind || "").trim()
  ].join("|");
}

async function uploadAttachmentsWithFirebaseFallback(owner, attachments) {
  const storageResult = await uploadAttachmentsToFirebaseStorage(owner, attachments);
  if (storageResult.ok || !Array.isArray(storageResult.skippedAttachments) || !storageResult.skippedAttachments.length) {
    return storageResult;
  }

  const skippedKeys = new Set(storageResult.skippedAttachments.map(getSkippedAttachmentKey));
  const fallbackAttachments = (Array.isArray(attachments) ? attachments : []).filter(file =>
    skippedKeys.has(getSkippedAttachmentKey(file))
  );
  const blobResult = await uploadAttachmentsToRealtimeDatabase(owner, fallbackAttachments);
  const storageWarning = blobResult.ok
    ? `${storageResult.storageWarning || "Firebase Storage no disponible."} Se guardaron los adjuntos en Firebase Realtime Database.`
    : `${storageResult.storageWarning || "Firebase Storage no disponible."} ${blobResult.storageWarning || ""}`.trim();
  return {
    ...storageResult,
    ok: blobResult.ok,
    savedFiles: [...(storageResult.savedFiles || []), ...(blobResult.savedFiles || [])],
    skippedAttachments: blobResult.skippedAttachments || [],
    storageWarning,
    fallbackStorageProvider: "firebase_realtime_database"
  };
}

async function withEvaluationWriteLock(id, task) {
  const key = normalizeId(id);
  const previous = evaluationWriteLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });
  const chained = previous.then(() => current, () => current);
  evaluationWriteLocks.set(key, chained);
  try {
    await previous.catch(() => {});
    return await task();
  } finally {
    release();
    if (evaluationWriteLocks.get(key) === chained) {
      evaluationWriteLocks.delete(key);
    }
  }
}

async function readEvaluationRecordsFromFirebase(options = {}) {
  const records = [];
  const deletedIds = new Set((await readSharedJson(DELETED_EVALUATIONS_KEY, []) || []).map(item => normalizeId(item?.id || item?.idEvaluacion || item)).filter(Boolean));
  const isDeleted = record => deletedIds.has(normalizeId(record?.id || record?.idEvaluacion));
  const compact = await readSharedJson(EVALUATIONS_KEY, []);
  if (Array.isArray(compact) && compact.length) {
    return compact
      .filter(record => !isDeleted(record))
      .map(normalizeEvaluationRecordForRuntime)
      .sort((a, b) => new Date(b.fechaEvaluacion || b.createdAt || 0) - new Date(a.fechaEvaluacion || a.createdAt || 0));
  }

  if (!options.includeDetailFallback) return [];
  const detailKeys = await listSharedKeys("evaluation_record_");
  for (const key of detailKeys) {
    const detail = await readSharedJson(key, null);
    if (detail && typeof detail === "object") records.push(detail);
  }

  const byId = new Map();
  for (const record of records) {
    const id = normalizeId(record?.id || record?.idEvaluacion);
    if (!id || deletedIds.has(id)) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...record, id });
  }
  return [...byId.values()]
    .map(normalizeEvaluationRecordForRuntime)
    .sort((a, b) => new Date(b.fechaEvaluacion || b.createdAt || 0) - new Date(a.fechaEvaluacion || a.createdAt || 0));
}

async function persistEvaluation(record) {
  const id = normalizeId(record?.id || record?.idEvaluacion);
  if (!id) throw new Error("No se puede guardar una evaluacion sin id.");
  const secciones = normalizeEvaluationSections(record?.secciones);
  const score = calculateEvaluationScore(secciones);
  const appliesCeroTolerancia = Boolean(record?.appliesCeroTolerancia) ||
    (Array.isArray(record?.zeroToleranceItems) && record.zeroToleranceItems.some(item => normalizeText(item?.resultado) === "cumple"));
  const normalized = {
    ...record,
    id,
    idEvaluacion: id,
    secciones,
    pesoAplicable: score.applicableWeight,
    puntajeLogrado: score.achievedWeight,
    resultadoGeneral: appliesCeroTolerancia ? "0.0% - Cero tolerancia" : score.text,
    appliesCeroTolerancia,
    updatedAt: nowIso()
  };
  await writeSharedRecord(getEvaluationRecordKey(id), normalized);
  const compact = await readSharedJson(EVALUATIONS_KEY, []);
  await writeSharedRecord(EVALUATIONS_KEY, upsertById(compact, normalized));
  return normalized;
}

export const gasHandlers = {
  async getData(key) {
    return await readSharedRecord(key);
  },

  async saveData(key, value) {
    return await writeSharedRecord(key, String(value || ""));
  },

  async deleteData(key) {
    return await deleteSharedRecord(key);
  },

  async listData(prefix = "") {
    const keys = await listSharedKeys(prefix);
    return keys.map(key => ({ key }));
  },

  async getBootstrapData() {
    const [
      users,
      historico,
      staffing,
      feedbackRecords,
      evaluationRecords,
      noTipificationRecords,
      legendConcepts,
      communications,
      chatMessages
    ] = await Promise.all([
      readSharedJson("users_v1", []),
      readSharedJson("snapshots_shared", []),
      readSharedJson("staffing", []),
      readSharedJson(FEEDBACK_KEY, []),
      readEvaluationRecordsFromFirebase(),
      readSharedJson("notip_records_v1", []),
      readSharedJson("legend_concepts_v1", []),
      readSharedJson(COMMUNICATIONS_KEY, []),
      readSharedJson("internal_chat_v1", [])
    ]);
    const result = {
      ok: true,
      source: "local_node_firebase",
      users: Array.isArray(users) ? users : [],
      historico: Array.isArray(historico) ? historico : [],
      staffing: Array.isArray(staffing) ? staffing : [],
      feedbackRecords: Array.isArray(feedbackRecords) ? feedbackRecords : [],
      evaluationRecords: Array.isArray(evaluationRecords) ? evaluationRecords : [],
      noTipificationRecords: Array.isArray(noTipificationRecords) ? noTipificationRecords : [],
      legendConcepts: Array.isArray(legendConcepts) ? legendConcepts : [],
      communications: Array.isArray(communications) ? sortCommunications(communications) : [],
      chatMessages: Array.isArray(chatMessages) ? chatMessages : [],
      errors: {}
    };
    result.counts = {
      users: result.users.length,
      historico: result.historico.length,
      staffing: result.staffing.length,
      feedbackRecords: result.feedbackRecords.length,
      evaluationRecords: result.evaluationRecords.length,
      noTipificationRecords: result.noTipificationRecords.length,
      legendConcepts: result.legendConcepts.length,
      communications: result.communications.length,
      chatMessages: result.chatMessages.length
    };
    return result;
  },

  async listCommunications(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    const canManage = canManageCommunications(currentUser);
    const includeArchived = Boolean(payload.includeArchived && canManage);
    const includeExpired = Boolean(payload.includeExpired && canManage);
    const records = await readCommunications();
    return sortCommunications(records
      .filter(item => canUserViewCommunication(currentUser, item))
      .filter(item => canManage ? true : normalizeText(item?.estado) === "publicado")
      .filter(item => includeArchived ? true : normalizeText(item?.estado) !== "archivado")
      .filter(item => includeExpired ? true : !isCommunicationExpired(item))
      .map(item => enrichCommunicationForUser(item, currentUser)));
  },

  async saveCommunication(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    requireRoles(currentUser, ["admin", "analista", "supervisor", "formador"], "No tienes permisos para administrar comunicados.");
    const title = String(payload.titulo || "").trim();
    const description = String(payload.descripcion || "").trim();
    const audience = String(payload.publicoObjetivo || "").trim();
    if (!title) throw new Error("El titulo del comunicado es obligatorio.");
    if (!description) throw new Error("La descripcion del comunicado es obligatoria.");
    if (!audience) throw new Error("Debes indicar el publico objetivo del comunicado.");

    const records = await readCommunications();
    const communicationId = Number(payload.id) || generateNumericId();
    const index = records.findIndex(item => Number(item?.id) === communicationId);
    const existing = index >= 0 ? records[index] : null;
    const now = nowIso();
    const record = {
      id: communicationId,
      titulo: title,
      descripcion: description,
      categoria: String(payload.categoria || existing?.categoria || "Informacion importante").trim(),
      publicoObjetivo: audience,
      etiquetas: Array.isArray(existing?.etiquetas) ? existing.etiquetas : [],
      prioridad: String(payload.prioridad || existing?.prioridad || "Media").trim(),
      estado: String(payload.estado || existing?.estado || "Publicado").trim(),
      fijado: Boolean(payload.fijado),
      enlaceAdjunto: String(payload.enlaceAdjunto || existing?.enlaceAdjunto || ""),
      fechaPublicacion: normalizeDateOrNow(payload.fechaPublicacion || existing?.fechaPublicacion),
      fechaVencimiento: String(payload.fechaVencimiento || existing?.fechaVencimiento || "").trim(),
      creadoPor: existing?.creadoPor || String(currentUser.nombre || "").trim(),
      creadorUsuario: existing?.creadorUsuario || String(currentUser.usuario || "").trim(),
      rolCreador: existing?.rolCreador || ROLE_LABELS[getRole(currentUser)] || getRole(currentUser),
      fechaCreacion: existing?.fechaCreacion || now,
      fechaActualizacion: now,
      comentarios: Array.isArray(existing?.comentarios) ? existing.comentarios : [],
      leidosPor: Array.isArray(existing?.leidosPor) ? existing.leidosPor : [],
      historialEdicion: Array.isArray(existing?.historialEdicion) ? existing.historialEdicion : [],
      files: Array.isArray(existing?.files) ? existing.files : []
    };
    record.historialEdicion.push({
      id: generateNumericId(),
      usuario: String(currentUser.usuario || "").trim(),
      nombre: String(currentUser.nombre || "").trim(),
      rol: ROLE_LABELS[getRole(currentUser)] || getRole(currentUser),
      accion: existing ? "update" : "create",
      fechaHora: now
    });
    if (index >= 0) records[index] = record;
    else records.push(record);
    await writeCommunications(records);
    return enrichCommunicationForUser(record, currentUser);
  },

  async deleteCommunication(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    requireRoles(currentUser, ["admin", "analista", "supervisor", "formador"], "No tienes permisos para eliminar comunicados.");
    const communicationId = Number(payload.id);
    if (!communicationId) throw new Error("El comunicado es obligatorio.");
    const records = await readCommunications();
    const index = records.findIndex(item => Number(item?.id) === communicationId);
    if (index < 0) throw new Error("No se encontro el comunicado solicitado.");
    records.splice(index, 1);
    await writeCommunications(records);
    return true;
  },

  async markCommunicationAsRead(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    const communicationId = Number(payload.id);
    if (!communicationId) throw new Error("El comunicado es obligatorio.");
    const records = await readCommunications();
    const index = records.findIndex(item => Number(item?.id) === communicationId);
    if (index < 0) throw new Error("No se encontro el comunicado solicitado.");
    const record = records[index];
    if (!canUserViewCommunication(currentUser, record)) throw new Error("No tienes permiso para leer este comunicado.");
    if (!Array.isArray(record.leidosPor)) record.leidosPor = [];
    const userId = normalizeText(currentUser.usuario);
    if (!record.leidosPor.some(item => normalizeText(item?.usuario) === userId)) {
      record.leidosPor.push({
        usuario: String(currentUser.usuario || "").trim(),
        nombre: String(currentUser.nombre || "").trim(),
        rol: ROLE_LABELS[getRole(currentUser)] || getRole(currentUser),
        fechaHora: nowIso()
      });
      record.fechaActualizacion = nowIso();
      records[index] = record;
      await writeCommunications(records);
    }
    return enrichCommunicationForUser(record, currentUser);
  },

  async addCommunicationComment(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    const communicationId = Number(payload.id);
    const text = String(payload.comentario || "").trim();
    if (!communicationId) throw new Error("El comunicado es obligatorio.");
    if (!text) throw new Error("El comentario no puede estar vacio.");
    const records = await readCommunications();
    const index = records.findIndex(item => Number(item?.id) === communicationId);
    if (index < 0) throw new Error("No se encontro el comunicado solicitado.");
    const record = records[index];
    if (!canUserViewCommunication(currentUser, record)) throw new Error("No tienes permiso para comentar este comunicado.");
    if (!Array.isArray(record.comentarios)) record.comentarios = [];
    record.comentarios.push({
      id: generateNumericId(),
      comentario: text,
      usuario: String(currentUser.usuario || "").trim(),
      nombre: String(currentUser.nombre || "").trim(),
      rol: ROLE_LABELS[getRole(currentUser)] || getRole(currentUser),
      fechaHora: nowIso(),
      parentId: Number(payload.parentId) || "",
      respuestas: []
    });
    record.fechaActualizacion = nowIso();
    records[index] = record;
    await writeCommunications(records);
    return enrichCommunicationForUser(record, currentUser);
  },

  async deleteCommunicationComment(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    const communicationId = Number(payload.id);
    const commentId = Number(payload.commentId);
    if (!communicationId || !commentId) throw new Error("El comentario es obligatorio.");
    const records = await readCommunications();
    const index = records.findIndex(item => Number(item?.id) === communicationId);
    if (index < 0) throw new Error("No se encontro el comunicado solicitado.");
    const record = records[index];
    if (!Array.isArray(record.comentarios)) record.comentarios = [];
    const commentIndex = record.comentarios.findIndex(item => Number(item?.id) === commentId);
    if (commentIndex < 0) throw new Error("No se encontro el comentario solicitado.");
    const comment = record.comentarios[commentIndex];
    const isOwner = normalizeText(comment?.usuario) === normalizeText(currentUser.usuario);
    if (!(getRole(currentUser) === "admin" || isOwner)) throw new Error("No tienes permisos para eliminar este comentario.");
    record.comentarios.splice(commentIndex, 1);
    record.fechaActualizacion = nowIso();
    records[index] = record;
    await writeCommunications(records);
    return enrichCommunicationForUser(record, currentUser);
  },

  async getCommunicationFilePreview(fileId) {
    const file = await findCommunicationFileById(fileId);
    return buildLocalDrivePreview(file);
  },

  async listFeedbackRecords() {
    return sortFeedbackRecords(await readFeedbackRecords());
  },

  async saveFeedbackRecord(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    requireRoles(currentUser, ["admin", "analista", "formador"], "No tienes permisos para crear feedbacks.");

    const assessor = String(payload.assessor || payload.asesorNombre || "").trim().toUpperCase();
    if (!assessor) throw new Error("El asesor es obligatorio para registrar feedback.");

    const tipoGestion = String(payload.tipoGestion || payload.feedbackCategory || "").trim();
    const clasificacionFeedback = String(payload.clasificacionFeedback || "").trim();
    const tipoRefuerzo = String(payload.tipoRefuerzo || "").trim();
    if (!tipoGestion) throw new Error("El tipo de gestion es obligatorio.");
    if (tipoGestion === "Feedback" && !clasificacionFeedback) throw new Error("La clasificacion del feedback es obligatoria.");
    if (tipoGestion === "Refuerzo" && !tipoRefuerzo) throw new Error("El tipo de refuerzo es obligatorio.");
    if (getRole(currentUser) === "formador" && tipoGestion !== "Refuerzo") throw new Error("El rol Formador solo puede crear registros de refuerzo.");

    const scheduledMeetingAt = String(payload.scheduledMeetingAt || "").trim();
    const notificationEmail = String(payload.notificationEmail || "").trim();
    if ((scheduledMeetingAt && !notificationEmail) || (!scheduledMeetingAt && notificationEmail)) {
      throw new Error("Para programar la cita online debes registrar fecha y hora junto con el correo de notificacion.");
    }

    const id = Number(payload.id) || generateNumericId();
    const now = nowIso();
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const record = {
      ...sanitizeRuntimePayload(payload),
      id,
      asesorId: String(payload.asesorId || payload.advisorUser || assessor).trim(),
      assessor,
      asesorNombre: assessor,
      auditorId: String(payload.auditorId || currentUser.usuario || "").trim(),
      auditorNombre: String(payload.authorName || currentUser.nombre || "").trim(),
      authorName: String(payload.authorName || currentUser.nombre || "").trim(),
      authorUser: String(payload.authorUser || currentUser.usuario || "").trim(),
      authorRole: String(payload.authorRole || ROLE_LABELS[getRole(currentUser)] || getRole(currentUser)).trim(),
      advisorUser: String(payload.advisorUser || "").trim(),
      feedbackCategory: tipoGestion,
      tipoGestion,
      clasificacionFeedback,
      tipoRefuerzo,
      campaign: String(payload.campaign || "").trim(),
      summary: tipoGestion,
      feedbackText: String(payload.feedbackText || "").trim(),
      observacionGeneral: String(payload.observacionGeneral || "").trim(),
      compromisoMejora: String(payload.compromisoMejora || "").trim(),
      resultadoGeneral: String(payload.resultadoGeneral || "").trim(),
      feedbackDate: normalizeDateOrNow(payload.feedbackDate),
      meetingType: String(payload.meetingType || "No especificado").trim(),
      scheduledMeetingAt,
      notificationEmail,
      meetingLink: String(payload.meetingLink || "").trim(),
      status: normalizeFeedbackStatusForSave(payload.advisorUser),
      estado: normalizeFeedbackStatusForSave(payload.advisorUser),
      files: Array.isArray(payload.files) ? payload.files : [],
      messages: [],
      createdAt: now,
      updatedAt: now
    };

    const records = await readFeedbackRecords();
    records.unshift(record);
    await writeFeedbackRecords(records);

    const storageResult = await uploadAttachmentsWithFirebaseFallback(
      {
        id: `feedback_${id}`,
        idEvaluacion: `feedback_${id}`,
        asesorNombre: assessor,
        files: record.files
      },
      attachments
    );
    const savedFiles = [...record.files, ...(storageResult.savedFiles || [])];
    const savedRecord = {
      ...buildFileFieldsFromSavedFiles(record, savedFiles, storageResult),
      estadoAdjuntos: attachments.length ? (storageResult.ok ? "completo" : "pendiente") : "sin_adjuntos",
      updatedAt: nowIso()
    };
    const nextRecords = await readFeedbackRecords();
    const index = nextRecords.findIndex(item => Number(item?.id) === id);
    if (index >= 0) nextRecords[index] = savedRecord;
    else nextRecords.unshift(savedRecord);
    await writeFeedbackRecords(nextRecords);
    return savedRecord;
  },

  async updateFeedbackRecord(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser || {
      usuario: payload.actorUser || payload.acceptedByUser,
      nombre: payload.actorName || payload.acceptedByName,
      rol: payload.actorRole
    });
    const feedbackId = Number(payload.id);
    if (!feedbackId) throw new Error("El id del feedback es obligatorio.");

    const records = await readFeedbackRecords();
    const index = records.findIndex(record => Number(record?.id) === feedbackId);
    if (index < 0) throw new Error("No se encontro el feedback solicitado.");

    const record = { ...records[index] };
    const action = String(payload.action || "").trim();
    const validActions = ["add_message", "submit_response", "accept_feedback", "reject_feedback", "submit_response_and_accept", "mark_viewed", "set_follow_up", "close_feedback"];
    if (!validActions.includes(action)) throw new Error("La accion de actualizacion no es valida.");

    const actorName = String(payload.acceptedByName || payload.actorName || currentUser.nombre || "").trim();
    const actorUser = String(payload.acceptedByUser || payload.actorUser || currentUser.usuario || "").trim();
    const actorRole = String(payload.actorRole || ROLE_LABELS[getRole(currentUser)] || getRole(currentUser)).trim();
    const actorIsAdvisor =
      normalizeText(actorUser) === normalizeText(record.advisorUser) ||
      getRole(currentUser) === "asesor";

    if (!canManageFeedback(currentUser) && !actorIsAdvisor) {
      throw new Error("No tienes permisos para acceder a este feedback.");
    }

    if (action === "mark_viewed") {
      if (!actorIsAdvisor) throw new Error("Solo el asesor puede marcar la lectura del feedback.");
      record.fechaVisualizacionAsesor = record.fechaVisualizacionAsesor || nowIso();
      if (record.estado === "pending") {
        record.estado = "viewed";
        record.status = "viewed";
      }
    }

    if (action === "add_message" || action === "submit_response" || action === "submit_response_and_accept") {
      const messageText = String(payload.messageText || payload.responseText || "").trim();
      if (!messageText) throw new Error("El mensaje no puede estar vacio.");
      appendFeedbackThreadMessage(record, { text: messageText, authorName: actorName, authorUser: actorUser, authorRole: actorRole });
      if (actorIsAdvisor) {
        record.comentarioAsesor = messageText;
        record.fechaVisualizacionAsesor = record.fechaVisualizacionAsesor || nowIso();
        if (record.estado === "pending") {
          record.estado = "viewed";
          record.status = "viewed";
        }
      }
    }

    if (action === "accept_feedback" || action === "reject_feedback" || action === "submit_response_and_accept") {
      if (!actorIsAdvisor) throw new Error("Solo el asesor puede validar el feedback.");
      const responseText = String(payload.responseText || payload.messageText || "").trim();
      if (!responseText) throw new Error("Para validar el feedback debes dejar un comentario.");
      if (isFeedbackAdvisorValidated(record) && record.estado !== "viewed" && record.estado !== "pending") {
        throw new Error("Este feedback ya fue validado por el asesor.");
      }
      const decision = action === "reject_feedback" ? "rejected" : "accepted";
      const decisionLabel = decision === "accepted" ? "Acepta feedback" : "No acepta feedback";
      const alreadyAdded = (action === "submit_response_and_accept");
      if (!alreadyAdded) {
        appendFeedbackThreadMessage(record, {
          text: `${decisionLabel}: ${responseText}`,
          authorName: actorName,
          authorUser: actorUser,
          authorRole: actorRole
        });
      }
      record.fechaVisualizacionAsesor = record.fechaVisualizacionAsesor || nowIso();
      record.advisorValidationStatus = decision;
      record.advisorDecision = decision;
      record.advisorValidationComment = responseText;
      record.advisorValidatedAt = nowIso();
      record.advisorValidatedBy = actorUser;
      record.advisorValidatedName = actorName;
      record.advisorAcceptedAt = decision === "accepted" ? nowIso() : "";
      record.advisorAcceptedBy = decision === "accepted" ? actorUser : "";
      record.advisorAcceptedName = decision === "accepted" ? actorName : "";
      record.comentarioAsesor = responseText;
      record.estado = decision === "accepted" ? "advisor_accepted" : "advisor_rejected";
      record.status = record.estado;
    }

    if (action === "set_follow_up") {
      requireRoles(currentUser, ["admin", "analista", "formador", "supervisor"], "No tienes permisos para marcar seguimiento.");
      record.estado = "in_follow_up";
      record.status = "in_follow_up";
    }

    if (action === "close_feedback") {
      requireRoles(currentUser, ["supervisor"], "Solo el supervisor puede cerrar la validacion final del feedback.");
      if (!isFeedbackAdvisorValidated(record)) {
        throw new Error("El asesor debe validar primero el feedback antes del cierre del supervisor.");
      }
      const closingComment = String(payload.responseText || payload.messageText || "").trim();
      if (!closingComment) throw new Error("Para cerrar el feedback debes dejar un comentario de validacion final.");
      appendFeedbackThreadMessage(record, {
        text: `Cierre supervisor: ${closingComment}`,
        authorName: actorName,
        authorUser: actorUser,
        authorRole: actorRole
      });
      record.supervisorValidationComment = closingComment;
      record.supervisorValidatedAt = nowIso();
      record.supervisorValidatedBy = actorUser;
      record.supervisorValidatedName = actorName;
      record.estado = "closed";
      record.status = "closed";
    }

    record.updatedAt = nowIso();
    record.updatedBy = String(currentUser.usuario || "").trim();
    records[index] = record;
    await writeFeedbackRecords(records);
    return record;
  },

  async getFeedbackFilePreview(fileId) {
    const file = await findFeedbackFileById(fileId);
    return buildLocalDrivePreview(file);
  },

  async listEvaluationRecords() {
    return await readEvaluationRecordsFromFirebase();
  },

  async listEvaluationRecordsFast() {
    return await readEvaluationRecordsFromFirebase();
  },

  async getEvaluationRecordDetail(id) {
    const deletedIds = new Set((await readSharedJson(DELETED_EVALUATIONS_KEY, []) || []).map(item => normalizeId(item?.id || item?.idEvaluacion || item)).filter(Boolean));
    if (deletedIds.has(normalizeId(id))) return null;
    const key = getEvaluationRecordKey(id);
    const detail = await readSharedJson(key, null);
    if (detail) return await enrichEvaluationWithDirectDriveFolder(normalizeEvaluationRecordForRuntime(detail));
    const records = await readEvaluationRecordsFromFirebase({ includeDetailFallback: false });
    const record = records.find(item => normalizeId(item?.id || item?.idEvaluacion) === normalizeId(id)) || null;
    return record ? await enrichEvaluationWithDirectDriveFolder(record) : null;
  },

  async saveEvaluationRecord(payload = {}) {
    const evaluationId = normalizeId(payload.idEvaluacion || payload.id) || String(generateNumericId());
    const currentUser = payload.currentUser || {};
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const evaluation = {
      ...sanitizeRuntimePayload(payload),
      id: evaluationId,
      idEvaluacion: evaluationId,
      fechaEvaluacion: normalizeDateOrNow(payload.fechaEvaluacion),
      asesorNombre: String(payload.asesorNombre || "").trim().toUpperCase(),
      auditorId: String(currentUser.usuario || payload.auditorId || "").trim(),
      auditorNombre: String(currentUser.nombre || payload.auditorNombre || "").trim(),
      estadoEvaluacion: String(payload.estadoEvaluacion || "open").trim(),
      files: Array.isArray(payload.files) ? payload.files : [],
      createdAt: payload.createdAt || nowIso(),
      updatedAt: nowIso()
    };

    const savedBeforeAttachments = await persistEvaluation(evaluation);
    const storageResult = await uploadAttachmentsWithFirebaseFallback(savedBeforeAttachments, attachments);
    const savedFiles = [...(savedBeforeAttachments.files || []), ...(storageResult.savedFiles || [])];
    const withAttachmentState = {
      ...buildFileFieldsFromSavedFiles(savedBeforeAttachments, savedFiles, storageResult),
      estadoAdjuntos: attachments.length ? (storageResult.ok ? "completo" : "pendiente") : "sin_adjuntos",
      updatedAt: nowIso()
    };
    return await persistEvaluation(withAttachmentState);
  },

  async updateEvaluationRecord(payload = {}) {
    const id = normalizeId(payload.idEvaluacion || payload.id);
    if (!id) throw new Error("No se puede actualizar una evaluacion sin id.");
    const current = await gasHandlers.getEvaluationRecordDetail(id);
    if (!current) throw new Error(`No se encontro la evaluacion ${id}.`);
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const updated = await persistEvaluation({ ...current, ...sanitizeRuntimePayload(payload), id, idEvaluacion: id });
    if (!attachments.length) return updated;
    const storageResult = await uploadAttachmentsWithFirebaseFallback(updated, attachments);
    const savedFiles = [...(updated.files || []), ...(storageResult.savedFiles || [])];
    return await persistEvaluation({
      ...buildFileFieldsFromSavedFiles(updated, savedFiles, storageResult),
      estadoAdjuntos: storageResult.ok ? "completo" : "pendiente",
      updatedAt: nowIso()
    });
  },

  async deleteEvaluationRecord(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    requireRoles(currentUser, ["admin"], "Solo administradores pueden borrar evaluaciones.");
    const id = normalizeId(payload.idEvaluacion || payload.id);
    if (!id) throw new Error("No se puede borrar una evaluacion sin id.");
    const compact = await readSharedJson(EVALUATIONS_KEY, []);
    const nextCompact = Array.isArray(compact)
      ? compact.filter(item => normalizeId(item?.id || item?.idEvaluacion) !== id)
      : [];
    const deleted = await readSharedJson(DELETED_EVALUATIONS_KEY, []);
    const deletedList = Array.isArray(deleted) ? deleted : [];
    const deletedExists = deletedList.some(item => normalizeId(item?.id || item?.idEvaluacion || item) === id);
    const nextDeleted = deletedExists
      ? deletedList
      : [{ id, deletedAt: nowIso(), deletedBy: String(currentUser.usuario || "").trim() }, ...deletedList];
    await deleteSharedRecord(getEvaluationRecordKey(id));
    await writeSharedRecord(EVALUATIONS_KEY, nextCompact);
    await writeSharedRecord(DELETED_EVALUATIONS_KEY, nextDeleted);
    return { ok: true, id };
  },

  async uploadEvaluationAttachment(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    requireRoles(currentUser, ["admin", "analista", "formador"], "No tienes permisos para subir adjuntos de evaluaciones.");
    const id = normalizeId(payload.idEvaluacion || payload.id);
    if (!id) throw new Error("El id de la evaluacion es obligatorio.");
    return await withEvaluationWriteLock(id, async () => {
      const current = await gasHandlers.getEvaluationRecordDetail(id);
      if (!current) throw new Error("No se encontro la evaluacion principal en Firebase.");

      const attachment = payload.attachment || null;
      if (!attachment || typeof attachment !== "object") {
        throw new Error("El adjunto de la evaluacion es obligatorio.");
      }
      const metadata = payload.attachmentMetadata && typeof payload.attachmentMetadata === "object" ? payload.attachmentMetadata : {};
      const normalizedAttachment = {
        ...attachment,
        name: attachment.name || metadata.name || "adjunto_evaluacion",
        mimeType: attachment.mimeType || metadata.mimeType || "application/octet-stream",
        kind: attachment.kind || metadata.kind || metadata.type || "evaluation_attachment",
        type: attachment.type || attachment.kind || metadata.kind || metadata.type || "evaluation_attachment",
        size: attachment.size || metadata.size || 0
      };

      const storageResult = await uploadAttachmentsWithFirebaseFallback(current, [normalizedAttachment]);
      const latest = await gasHandlers.getEvaluationRecordDetail(id) || current;
      const savedFiles = mergeFilesByIdentity(
        current.files,
        latest.files,
        storageResult.savedFiles
      );
      const next = {
        ...buildFileFieldsFromSavedFiles(latest, savedFiles, storageResult),
        estadoAdjuntos: storageResult.ok ? "completo" : "pendiente",
        reintentoPendiente: !storageResult.ok,
        ultimoErrorAdjuntos: storageResult.ok ? "" : (storageResult.storageWarning || "No se pudo guardar el adjunto."),
        errorAdjuntos: storageResult.ok ? "" : (storageResult.storageWarning || "No se pudo guardar el adjunto."),
        attachmentFailures: storageResult.ok ? [] : (storageResult.skippedAttachments || []),
        updatedAt: nowIso(),
        updatedBy: currentUser.usuario
      };
      return await persistEvaluation(next);
    });
  },

  async markEvaluationAttachmentsPending(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    requireRoles(currentUser, ["admin", "analista", "formador"], "No tienes permisos para actualizar adjuntos de evaluaciones.");
    const id = normalizeId(payload.idEvaluacion || payload.id);
    if (!id) throw new Error("El id de la evaluacion es obligatorio.");
    const current = await gasHandlers.getEvaluationRecordDetail(id);
    if (!current) throw new Error("No se encontro la evaluacion principal en Firebase.");
    const message = String(payload.errorAdjuntos || payload.ultimoErrorAdjuntos || "Error de conexion al subir adjuntos.").trim();
    return await persistEvaluation({
      ...current,
      estadoAdjuntos: String(payload.estadoAdjuntos || "error_red_drive").trim(),
      reintentoPendiente: true,
      ultimoErrorAdjuntos: message,
      errorAdjuntos: message,
      fechaErrorAdjuntos: nowIso(),
      attachmentFailures: Array.isArray(payload.attachmentFailures) ? payload.attachmentFailures : [],
      updatedAt: nowIso(),
      updatedBy: currentUser.usuario
    });
  },

  async validarConexiones() {
    const keys = await listSharedKeys("");
    return {
      firebase: {
        ok: true,
        keysFound: keys.slice(0, 25),
        evaluationRecordKeysFound: keys.filter(key => key.startsWith("evaluation_record_")).length
      },
      googleSheet: {
        ok: false,
        error: "Google Sheets queda como referencia de lectura; pendiente migrar lector Node."
      },
      drive: {
        ...(await validateDriveConnection())
      },
      firebaseStorage: {
        ...(await validateFirebaseStorageConnection())
      }
    };
  }
};
