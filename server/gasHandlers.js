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
const COMMUNICATIONS_KEY = "communications_v1";
const FEEDBACK_KEY = "feedback_records_v2";

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

function sanitizeRuntimePayload(payload = {}) {
  const { attachments, currentUser, attachment, attachmentMetadata, ...rest } = payload;
  return rest;
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

async function readEvaluationRecordsFromFirebase(options = {}) {
  const records = [];
  const compact = await readSharedJson(EVALUATIONS_KEY, []);
  if (Array.isArray(compact) && compact.length) {
    return compact.sort((a, b) => new Date(b.fechaEvaluacion || b.createdAt || 0) - new Date(a.fechaEvaluacion || a.createdAt || 0));
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
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...record, id });
  }
  return [...byId.values()].sort((a, b) => new Date(b.fechaEvaluacion || b.createdAt || 0) - new Date(a.fechaEvaluacion || a.createdAt || 0));
}

async function persistEvaluation(record) {
  const id = normalizeId(record?.id || record?.idEvaluacion);
  if (!id) throw new Error("No se puede guardar una evaluacion sin id.");
  const normalized = { ...record, id, idEvaluacion: id, updatedAt: nowIso() };
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

    const storageResult = await uploadAttachmentsToFirebaseStorage(
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
    const validActions = ["add_message", "submit_response", "accept_feedback", "submit_response_and_accept", "mark_viewed", "set_follow_up", "close_feedback"];
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

    if (action === "accept_feedback" || action === "submit_response_and_accept") {
      if (!actorIsAdvisor) throw new Error("Solo el asesor puede aceptar el feedback.");
      record.fechaVisualizacionAsesor = record.fechaVisualizacionAsesor || nowIso();
      record.advisorAcceptedAt = nowIso();
      record.advisorAcceptedBy = actorUser;
      record.advisorAcceptedName = actorName;
      record.estado = "accepted";
      record.status = "accepted";
    }

    if (action === "set_follow_up") {
      requireRoles(currentUser, ["admin", "analista", "formador", "supervisor"], "No tienes permisos para marcar seguimiento.");
      record.estado = "in_follow_up";
      record.status = "in_follow_up";
    }

    if (action === "close_feedback") {
      requireRoles(currentUser, ["admin", "analista"], "Solo administradores y analistas pueden cerrar feedbacks.");
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
    const key = getEvaluationRecordKey(id);
    const detail = await readSharedJson(key, null);
    if (detail) return await enrichEvaluationWithDirectDriveFolder(detail);
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
    const storageResult = await uploadAttachmentsToFirebaseStorage(savedBeforeAttachments, attachments);
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
    const storageResult = await uploadAttachmentsToFirebaseStorage(updated, attachments);
    const savedFiles = [...(updated.files || []), ...(storageResult.savedFiles || [])];
    return await persistEvaluation({
      ...buildFileFieldsFromSavedFiles(updated, savedFiles, storageResult),
      estadoAdjuntos: storageResult.ok ? "completo" : "pendiente",
      updatedAt: nowIso()
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
