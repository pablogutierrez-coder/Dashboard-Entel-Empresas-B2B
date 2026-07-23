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
const OPERATIONAL_INCIDENTS_KEY = "operational_incidents_v1";
const SALES_VALIDATIONS_KEY = "sales_validations_v1";
const CALIBRATION_SESSIONS_KEY = "calibration_sessions";
const CALIBRATION_PARTICIPANTS_KEY = "calibration_participants";
const CALIBRATION_EVALUATIONS_KEY = "calibration_evaluations";
const CALIBRATION_EVALUATION_ITEMS_KEY = "calibration_evaluation_items";
const CALIBRATION_RESULTS_KEY = "calibration_results";
const CALIBRATION_COMPARISON_KEY = "calibration_response_comparison";
const CALIBRATION_ACTIVITY_LOGS_KEY = "calibration_activity_logs";
const evaluationWriteLocks = new Map();
const firebaseReadCache = new Map();
const CACHE_TTL_MS = 15000;

const ROLE_LABELS = {
  admin: "Administrador",
  analista: "Analista",
  supervisor: "Supervisor",
  formador: "Formador",
  referente_experto: "Referente Experto",
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

async function readCachedSharedJson(key, fallback = [], ttlMs = CACHE_TTL_MS) {
  const now = Date.now();
  const cached = firebaseReadCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = await readSharedJson(key, fallback);
  firebaseReadCache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

function invalidateFirebaseCache(...keys) {
  const cleanKeys = keys.flat().filter(Boolean).map(String);
  if (!cleanKeys.length) {
    firebaseReadCache.clear();
    return;
  }
  cleanKeys.forEach(key => firebaseReadCache.delete(key));
}

function getRole(user) {
  const role = normalizeText(user?.rol || user?.role || "");
  const aliases = {
    administrador: "admin",
    administration: "admin",
    administrator: "admin",
    monitor: "analista",
    analyst: "analista",
    calidad: "analista",
    quality: "analista",
    validador: "analista",
    validator: "analista",
    trainer: "formador",
    coach: "formador",
    advisor: "asesor",
    sistema: "sistemas",
    systems: "sistemas"
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

function canViewSalesValidation(user) {
  return ["admin", "analista", "supervisor", "formador", "sistemas", "sistema"].includes(getRole(user));
}

function canManageSalesValidation(user) {
  return ["admin", "analista"].includes(getRole(user));
}

function canDeleteSalesValidation(user) {
  return getRole(user) === "admin";
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
  const records = await readCachedSharedJson(COMMUNICATIONS_KEY, []);
  return Array.isArray(records) ? records : [];
}

async function writeCommunications(records) {
  await writeSharedRecord(COMMUNICATIONS_KEY, Array.isArray(records) ? records : []);
  invalidateFirebaseCache(COMMUNICATIONS_KEY);
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
  const records = await readCachedSharedJson(FEEDBACK_KEY, []);
  return Array.isArray(records) ? records : [];
}

async function writeFeedbackRecords(records) {
  await writeSharedRecord(FEEDBACK_KEY, Array.isArray(records) ? records : []);
  invalidateFirebaseCache(FEEDBACK_KEY);
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
  if (status === "in follow up" || status === "in_follow_up") return false;
  return ["accepted", "rejected", "advisor accepted", "advisor rejected", "advisor_accepted", "advisor_rejected"].includes(validation) ||
    ["accepted", "rejected", "advisor accepted", "advisor rejected", "advisor_accepted", "advisor_rejected"].includes(status) ||
    !!record.advisorValidatedAt ||
    !!record.advisorAcceptedAt;
}

function isFeedbackAssignedToSupervisor(record = {}, user = {}) {
  const assignedUser = String(record.supervisorUser || record.supervisorId || "").trim();
  if (assignedUser) return normalizeText(assignedUser) === normalizeText(user.usuario);
  const assignedName = String(record.supervisorName || record.supervisor || "").trim();
  if (!assignedName) return true;
  const userKeys = [user.nombre, user.usuario, user.assessorName].map(normalizeText).filter(Boolean);
  const assignedKey = normalizeText(assignedName);
  return userKeys.some(key => key === assignedKey || (key.length > 6 && assignedKey.length > 6 && (key.includes(assignedKey) || assignedKey.includes(key))));
}

function sanitizeRuntimePayload(payload = {}) {
  const { attachments, currentUser, attachment, attachmentMetadata, ...rest } = payload;
  return rest;
}

const EVALUATION_FORM_TYPES = {
  venta: { label: "Venta" },
  no_venta: { label: "No venta" },
  mala_practica: { label: "Mala practica" }
};

const DEFAULT_CLIENT_ID = "entel_b2b";
const CULQI_CLIENT_ID = "culqi_bcp";

const EVALUATION_FORM_TEMPLATES = {
  venta: [
    { categoria: "1. Conecta: Entrada y Validacion", pesoItem: 5, nombreSeccion: "1.1 Saludo e Identificacion", criterio: "Saludo e identificacion", pesoSub: 2 },
    { categoria: "1. Conecta: Entrada y Validacion", pesoItem: 5, nombreSeccion: "1.2 Validacion del Titular o Decisor", criterio: "Validacion del titular o decisor", pesoSub: 3 },
    { categoria: "2. Diagnostica: Diagnostico Comercial", pesoItem: 10, nombreSeccion: "2.1 Sondeo estrategico", criterio: "Sondeo estrategico", pesoSub: 10 },
    { categoria: "3. Construye Valor: Presentacion de la Oferta", pesoItem: 20, nombreSeccion: "3.1 Presentacion de la Oferta", criterio: "Presentacion de la oferta", pesoSub: 6 },
    { categoria: "3. Construye Valor: Presentacion de la Oferta", pesoItem: 20, nombreSeccion: "3.2 Plan, Beneficios e IGV", criterio: "Plan, beneficios e IGV", pesoSub: 10 },
    { categoria: "3. Construye Valor: Presentacion de la Oferta", pesoItem: 20, nombreSeccion: "3.3 Entrega, Portabilidad y Plazos", criterio: "Entrega, portabilidad y plazos", pesoSub: 4 },
    { categoria: "4. Experiencia del Cliente", pesoItem: 10, nombreSeccion: "4.1 Manejo de objeciones", criterio: "Manejo de objeciones", pesoSub: 10 },
    { categoria: "5. Formaliza: Contratacion Telefonica", pesoItem: 35, nombreSeccion: "5.1 Validaciones y Numero a Portar", criterio: "Validaciones y numero a portar", pesoSub: 10 },
    { categoria: "5. Formaliza: Contratacion Telefonica", pesoItem: 35, nombreSeccion: "5.2 Lectura de Contrato y Confirmacion Grabada", criterio: "Lectura de contrato y confirmacion grabada", pesoSub: 15 },
    { categoria: "5. Formaliza: Contratacion Telefonica", pesoItem: 35, nombreSeccion: "5.3 Informacion de Portabilidad y Activacion", criterio: "Informacion de portabilidad y activacion", pesoSub: 10 },
    { categoria: "6. Fideliza: Cierre y Tipificacion", pesoItem: 10, nombreSeccion: "6.1 Cierre de ventas", criterio: "Cierre de ventas", pesoSub: 5 },
    { categoria: "6. Fideliza: Cierre y Tipificacion", pesoItem: 10, nombreSeccion: "6.2 Tipificacion y sistemas", criterio: "Tipificacion y sistemas", pesoSub: 5 },
    { categoria: "7. Estandar Transversal: Experiencia del Cliente", pesoItem: 10, nombreSeccion: "7.1 Escucha activa y empatia", criterio: "Escucha activa y empatia", pesoSub: 5 },
    { categoria: "7. Estandar Transversal: Experiencia del Cliente", pesoItem: 10, nombreSeccion: "7.2 Tono Profesional y Claridad", criterio: "Tono profesional y claridad", pesoSub: 5 }
  ],
  no_venta: [
    { categoria: "1. Conecta: Entrada y Validacion", pesoItem: 10, nombreSeccion: "1.1 Saludo e Identificacion", criterio: "Saludo e identificacion", pesoSub: 4 },
    { categoria: "1. Conecta: Entrada y Validacion", pesoItem: 10, nombreSeccion: "1.2 Validacion del Titular o Decisor", criterio: "Validacion del titular o decisor", pesoSub: 6 },
    { categoria: "2. Diagnostica: Diagnostico Comercial", pesoItem: 20, nombreSeccion: "2.1 Sondeo estrategico", criterio: "Sondeo estrategico", pesoSub: 20 },
    { categoria: "3. Construye Valor: Presentacion de la Oferta", pesoItem: 25, nombreSeccion: "3.1 Presentacion de la Oferta", criterio: "Presentacion de la oferta", pesoSub: 8 },
    { categoria: "3. Construye Valor: Presentacion de la Oferta", pesoItem: 25, nombreSeccion: "3.2 Plan, Beneficios e IGV", criterio: "Plan, beneficios e IGV", pesoSub: 12 },
    { categoria: "3. Construye Valor: Presentacion de la Oferta", pesoItem: 25, nombreSeccion: "3.3 Entrega, Portabilidad y Plazos", criterio: "Entrega, portabilidad y plazos", pesoSub: 5 },
    { categoria: "4. Experiencia del Cliente", pesoItem: 25, nombreSeccion: "4.1 Manejo de objeciones", criterio: "Manejo de objeciones", pesoSub: 25 },
    { categoria: "5. Formaliza: Contratacion Telefonica", pesoItem: 0, nombreSeccion: "5.1 Validaciones y Numero a Portar", criterio: "Validaciones y numero a portar", pesoSub: 0 },
    { categoria: "5. Formaliza: Contratacion Telefonica", pesoItem: 0, nombreSeccion: "5.2 Lectura de Contrato y Confirmacion Grabada", criterio: "Lectura de contrato y confirmacion grabada", pesoSub: 0 },
    { categoria: "5. Formaliza: Contratacion Telefonica", pesoItem: 0, nombreSeccion: "5.3 Informacion de Portabilidad y Activacion", criterio: "Informacion de portabilidad y activacion", pesoSub: 0 },
    { categoria: "6. Fideliza: Cierre y Tipificacion", pesoItem: 10, nombreSeccion: "6.1 Cierre de ventas", criterio: "Cierre de ventas", pesoSub: 5 },
    { categoria: "6. Fideliza: Cierre y Tipificacion", pesoItem: 10, nombreSeccion: "6.2 Tipificacion y sistemas", criterio: "Tipificacion y sistemas", pesoSub: 5 },
    { categoria: "7. Estandar Transversal: Experiencia del Cliente", pesoItem: 10, nombreSeccion: "7.1 Escucha activa y empatia", criterio: "Escucha activa y empatia", pesoSub: 5 },
    { categoria: "7. Estandar Transversal: Experiencia del Cliente", pesoItem: 10, nombreSeccion: "7.2 Tono Profesional y Claridad", criterio: "Tono profesional y claridad", pesoSub: 5 }
  ],
  mala_practica: []
};

const CULQI_EVALUATION_FORM_TEMPLATES = {
  venta: [
    { categoria: "1. Apertura y Validacion", pesoItem: 20, nombreSeccion: "1.1 Presentacion y Grabacion", criterio: "Presentacion y grabacion", pesoSub: 10 },
    { categoria: "1. Apertura y Validacion", pesoItem: 20, nombreSeccion: "1.2 Validacion y Autoridad", criterio: "Validacion y autoridad", pesoSub: 10 },
    { categoria: "2. Propuesta del Producto", pesoItem: 15, nombreSeccion: "2.1 Explicacion Funcional", criterio: "Explicacion funcional", pesoSub: 10 },
    { categoria: "2. Propuesta del Producto", pesoItem: 15, nombreSeccion: "2.2 Beneficios Reales", criterio: "Beneficios reales", pesoSub: 5 },
    { categoria: "3. Condiciones Economicas", pesoItem: 25, nombreSeccion: "3.1 Tasas y cobro de IGV", criterio: "Tasas y cobro de IGV", pesoSub: 15 },
    { categoria: "3. Condiciones Economicas", pesoItem: 25, nombreSeccion: "3.2 Costos y Membresias", criterio: "Costos y membresias", pesoSub: 10 },
    { categoria: "4. Politicas de Uso", pesoItem: 20, nombreSeccion: "4.1 Facturacion Minima (GPV)", criterio: "Facturacion minima GPV", pesoSub: 10 },
    { categoria: "4. Politicas de Uso", pesoItem: 20, nombreSeccion: "4.2 Condiciones de Recojo", criterio: "Condiciones de recojo", pesoSub: 10 },
    { categoria: "5. Cierre de Venta", pesoItem: 15, nombreSeccion: "5.1 Resumen y Aceptacion", criterio: "Resumen y aceptacion", pesoSub: 10 },
    { categoria: "5. Cierre de Venta", pesoItem: 15, nombreSeccion: "5.2 Datos para Visita/Envio", criterio: "Datos para visita o envio", pesoSub: 5 },
    { categoria: "6. Gestion y Trato", pesoItem: 5, nombreSeccion: "6.1 Resolucion de Dudas", criterio: "Resolucion de dudas", pesoSub: 2.5 },
    { categoria: "6. Gestion y Trato", pesoItem: 5, nombreSeccion: "6.2 Trato y Tipificacion", criterio: "Trato y tipificacion", pesoSub: 2.5 }
  ],
  no_venta: [
    { categoria: "1. Protocolo de Inicio", pesoItem: 15, nombreSeccion: "1.1 Presentacion y Motivo", criterio: "Presentacion y motivo", pesoSub: 10 },
    { categoria: "1. Protocolo de Inicio", pesoItem: 15, nombreSeccion: "1.2 Trato e Interes Inicial", criterio: "Trato e interes inicial", pesoSub: 5 },
    { categoria: "2. Sondeo Comercial", pesoItem: 20, nombreSeccion: "2.1 Indagacion del Negocio", criterio: "Indagacion del negocio", pesoSub: 10 },
    { categoria: "2. Sondeo Comercial", pesoItem: 20, nombreSeccion: "2.2 Sondeo Estrategico", criterio: "Sondeo estrategico", pesoSub: 10 },
    { categoria: "3. Presentacion de Oferta", pesoItem: 20, nombreSeccion: "3.1 Explicacion del POS", criterio: "Explicacion del POS", pesoSub: 10 },
    { categoria: "3. Presentacion de Oferta", pesoItem: 20, nombreSeccion: "3.2 Transparencia", criterio: "Transparencia", pesoSub: 10 },
    { categoria: "4. Manejo de Objeciones", pesoItem: 30, nombreSeccion: "4.1 Escucha de la Objecion", criterio: "Escucha de la objecion", pesoSub: 15 },
    { categoria: "4. Manejo de Objeciones", pesoItem: 30, nombreSeccion: "4.2 Rebate / Argumentacion", criterio: "Rebate / argumentacion", pesoSub: 15 },
    { categoria: "5. Cierre y Despedida", pesoItem: 10, nombreSeccion: "5.1 Alternativa de Seguimiento", criterio: "Alternativa de seguimiento", pesoSub: 5 },
    { categoria: "5. Cierre y Despedida", pesoItem: 10, nombreSeccion: "5.2 Cierre Cordial", criterio: "Cierre cordial", pesoSub: 5 },
    { categoria: "6. Gestion del Sistema", pesoItem: 5, nombreSeccion: "6.1 Tipificacion", criterio: "Tipificacion", pesoSub: 2.5 },
    { categoria: "6. Gestion del Sistema", pesoItem: 5, nombreSeccion: "6.2 Registro de Comentarios", criterio: "Registro de comentarios", pesoSub: 2.5 }
  ],
  mala_practica: []
};

const EVALUATION_FORM_TEMPLATES_BY_CLIENT = {
  [DEFAULT_CLIENT_ID]: EVALUATION_FORM_TEMPLATES,
  [CULQI_CLIENT_ID]: CULQI_EVALUATION_FORM_TEMPLATES
};

function normalizeClientId(value) {
  const raw = String(value || DEFAULT_CLIENT_ID).trim();
  return raw === CULQI_CLIENT_ID ? CULQI_CLIENT_ID : DEFAULT_CLIENT_ID;
}

function getEvaluationTemplatesForClient(clientId) {
  return EVALUATION_FORM_TEMPLATES_BY_CLIENT[normalizeClientId(clientId)] || EVALUATION_FORM_TEMPLATES;
}

function normalizeEvaluationFormType(value) {
  const normalized = normalizeText(value);
  if (["no venta", "no_venta", "noventa"].includes(normalized)) return "no_venta";
  if (["mala practica", "mala_practica", "mala practica comercial", "cero tolerancia"].includes(normalized)) return "mala_practica";
  return "venta";
}

function getDefaultEvaluationSections(formType, clientId = DEFAULT_CLIENT_ID) {
  const type = normalizeEvaluationFormType(formType);
  const templates = getEvaluationTemplatesForClient(clientId);
  return (templates[type] || templates.venta)
    .map(section => ({ resultado: "", detalleAuditado: "", oportunidadMejora: "", evidencia: "", puntaje: 0, ...section }));
}

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
  }) || items.find(item => {
    const itemKeys = getEvaluationItemIdentityValues(item);
    return itemKeys.some(itemKey => templateKeys.some(templateKey => itemKey.includes(templateKey) || templateKey.includes(itemKey)));
  }) || null;
}

function getStoredSectionResult(stored, templateSection) {
  const explicitResult = stored?.resultado ?? stored?.cumplimiento ?? stored?.estadoCumplimiento ?? stored?.respuesta ?? stored?.resultadoItem ?? stored?.resultadoAtributo ?? stored?.status;
  if (explicitResult !== undefined && explicitResult !== null && String(explicitResult).trim() !== "") return explicitResult;
  const score = stored?.puntaje;
  if (score !== undefined && score !== null && String(score).trim() !== "") {
    const numericScore = Number(score);
    const weight = Number(templateSection?.pesoSub || stored?.pesoSub || 0) || 0;
    if (!Number.isNaN(numericScore) && weight > 0) return numericScore >= weight ? "Cumple" : "No cumple";
  }
  return templateSection.resultado;
}

function normalizeEvaluationSections(sections, formType, clientId = DEFAULT_CLIENT_ID) {
  const source = Array.isArray(sections) ? sections : [];
  return getDefaultEvaluationSections(formType, clientId).map(templateSection => {
    const stored = findMatchingEvaluationItem(source, templateSection) || {};
    const result = getStoredSectionResult(stored, templateSection);
    return {
      ...stored,
      categoria: templateSection.categoria,
      pesoItem: templateSection.pesoItem,
      nombreSeccion: templateSection.nombreSeccion,
      criterio: templateSection.criterio,
      pesoSub: templateSection.pesoSub,
      resultado: result,
      detalleAuditado: stored.detalleAuditado || "",
      oportunidadMejora: stored.oportunidadMejora || "",
      evidencia: stored.evidencia || "",
      puntaje: stored.puntaje !== undefined ? stored.puntaje : templateSection.puntaje
    };
  });
}

function calculateEvaluationScore(sections, formType, clientId = DEFAULT_CLIENT_ID) {
  let applicableWeight = 0;
  let achievedWeight = 0;
  for (const section of normalizeEvaluationSections(sections, formType, clientId)) {
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
  const evaluationFormType = normalizeEvaluationFormType(record.evaluationFormType || record.tipoFicha || record.formType || "venta");
  const clientId = normalizeClientId(record.clientId || record.platformId);
  const secciones = normalizeEvaluationSections(record.secciones, evaluationFormType, clientId);
  const score = calculateEvaluationScore(secciones, evaluationFormType, clientId);
  const appliesCeroTolerancia = Boolean(record.appliesCeroTolerancia) ||
    evaluationFormType === "mala_practica" ||
    (Array.isArray(record.zeroToleranceItems) && record.zeroToleranceItems.some(item => normalizeText(item?.resultado) === "cumple"));
  return {
    ...record,
    clientId,
    platformId: clientId,
    evaluationFormType,
    tipoFicha: EVALUATION_FORM_TYPES[evaluationFormType]?.label || "Venta",
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
  const deletedIds = new Set((await readCachedSharedJson(DELETED_EVALUATIONS_KEY, []) || []).map(item => normalizeId(item?.id || item?.idEvaluacion || item)).filter(Boolean));
  const isDeleted = record => deletedIds.has(normalizeId(record?.id || record?.idEvaluacion));
  const compact = await readCachedSharedJson(EVALUATIONS_KEY, []);
  if (Array.isArray(compact) && compact.length) {
    return compact
      .filter(record => !isDeleted(record))
      .map(normalizeEvaluationRecordForRuntime)
      .sort((a, b) => new Date(b.fechaEvaluacion || b.createdAt || 0) - new Date(a.fechaEvaluacion || a.createdAt || 0));
  }

  if (!options.includeDetailFallback) return [];
  const detailKeys = await listSharedKeys("evaluation_record_");
  for (const key of detailKeys) {
    const detail = await readCachedSharedJson(key, null);
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
  const evaluationFormType = normalizeEvaluationFormType(record?.evaluationFormType || record?.tipoFicha || record?.formType || "venta");
  const clientId = normalizeClientId(record?.clientId || record?.platformId);
  const secciones = normalizeEvaluationSections(record?.secciones, evaluationFormType, clientId);
  const score = calculateEvaluationScore(secciones, evaluationFormType, clientId);
  const appliesCeroTolerancia = Boolean(record?.appliesCeroTolerancia) ||
    evaluationFormType === "mala_practica" ||
    (Array.isArray(record?.zeroToleranceItems) && record.zeroToleranceItems.some(item => normalizeText(item?.resultado) === "cumple"));
  const normalized = {
    ...record,
    id,
    idEvaluacion: id,
    clientId,
    platformId: clientId,
    evaluationFormType,
    tipoFicha: EVALUATION_FORM_TYPES[evaluationFormType]?.label || "Venta",
    secciones,
    pesoAplicable: score.applicableWeight,
    puntajeLogrado: score.achievedWeight,
    resultadoGeneral: appliesCeroTolerancia ? "0.0% - Cero tolerancia" : score.text,
    appliesCeroTolerancia,
    updatedAt: nowIso()
  };
  await writeSharedRecord(getEvaluationRecordKey(id), normalized);
  const compact = await readCachedSharedJson(EVALUATIONS_KEY, []);
  await writeSharedRecord(EVALUATIONS_KEY, upsertById(compact, normalized));
  invalidateFirebaseCache(EVALUATIONS_KEY, getEvaluationRecordKey(id));
  return normalized;
}

function normalizeCalibrationStatus(value) {
  const normalized = normalizeText(value);
  const aliases = {
    borrador: "draft",
    draft: "draft",
    programada: "scheduled",
    scheduled: "scheduled",
    "en vivo": "live",
    live: "live",
    finalizada: "finalized",
    finalized: "finalized",
    "cerrada con resultados": "closed_results",
    closed: "closed_results",
    "closed results": "closed_results",
    closed_results: "closed_results",
    anulada: "annulled",
    annullada: "annulled",
    cancelled: "annulled",
    canceled: "annulled",
    annulled: "annulled"
  };
  return aliases[normalized] || "draft";
}

function normalizeCalibrationResult(value) {
  const normalized = normalizeText(value);
  if (["cumple", "correcto", "ok", "aprobado"].includes(normalized)) return "cumple";
  if (["no cumple", "incumple", "incorrecto", "error", "mala practica"].includes(normalized) || normalized.includes("no cumple")) return "no_cumple";
  if (["no aplica", "na", "n/a", "no aplicable"].includes(normalized)) return "no_aplica";
  return normalized || "";
}

function getCalibrationSectionKey(section = {}) {
  return normalizeText(section.nombreSeccion || section.subItem || section.item || section.criterio || section.pregunta || section.id || "");
}

function getUserCalibrationArea(user = {}) {
  const role = getRole(user);
  if (String(user.area || "").trim()) return String(user.area).trim();
  if (role === "formador") return "Formacion";
  if (role === "analista" || role === "admin" || role === "referente_experto") return "Calidad";
  if (role === "supervisor" || role === "asesor") return "Operaciones";
  return "Otros";
}

async function readCalibrationCollection(key) {
  const value = await readCachedSharedJson(key, []);
  return Array.isArray(value) ? value : [];
}

async function writeCalibrationCollection(key, records) {
  await writeSharedRecord(key, Array.isArray(records) ? records : []);
  invalidateFirebaseCache(key);
}

async function addCalibrationLog(sessionId, user, actionType, description) {
  const logs = await readCalibrationCollection(CALIBRATION_ACTIVITY_LOGS_KEY);
  const log = {
    id: normalizeId(generateNumericId()),
    calibration_session_id: normalizeId(sessionId),
    user_id: String(user?.usuario || user?.user_id || "").trim(),
    user_name: String(user?.nombre || user?.user_name || "").trim(),
    role: getRole(user),
    action_type: String(actionType || "").trim(),
    action_description: String(description || "").trim(),
    created_at: nowIso()
  };
  await writeCalibrationCollection(CALIBRATION_ACTIVITY_LOGS_KEY, [log, ...logs]);
  return log;
}

function canManageCalibration(user) {
  return ["admin", "analista"].includes(getRole(user));
}

function canViewCalibrationModule(user) {
  return ["admin", "analista", "supervisor", "formador", "referente_experto"].includes(getRole(user));
}

function canUserSeeCalibration(session, user) {
  if (canManageCalibration(user)) return true;
  const userId = String(user?.usuario || "").trim();
  if (!userId) return false;
  if (String(session?.expert_referent_id || "") === userId) return true;
  return (session?.participants || []).some(item => String(item?.user_id || "") === userId);
}

function validateCalibrationCanStart(session) {
  const required = [
    ["title", "nombre de la calibracion"],
    ["evaluation_type", "tipo de audio"],
    ["call_date", "fecha de llamada"],
    ["call_time", "hora de llamada"],
    ["campaign_name", "campana o servicio"],
    ["evaluated_agent_name", "asesor evaluado"],
    ["call_typification", "tipificacion"],
    ["call_result", "resultado de llamada"],
    ["expert_referent_id", "Referente Experto"]
  ];
  const missing = required.filter(([key]) => !String(session?.[key] || "").trim()).map(([, label]) => label);
  const hasAudio = Boolean(session?.audio_url || session?.audio_file?.previewUrl || session?.audio_file?.downloadUrl || session?.audio_file?.id);
  if (!hasAudio) missing.push("audio de la llamada");
  if (!Array.isArray(session?.participants) || !session.participants.length) missing.push("participantes");
  if (missing.length) throw new Error(`No se puede iniciar la calibracion. Faltan: ${missing.join(", ")}.`);
}

function buildCalibrationParticipantRecord(sessionId, user, overrides = {}) {
  const userId = String(overrides.user_id || user?.user_id || user?.usuario || "").trim();
  return {
    id: `${sessionId}_${userId}`,
    calibration_session_id: sessionId,
    user_id: userId,
    user_name: String(overrides.user_name || user?.user_name || user?.nombre || "").trim(),
    role: String(overrides.role || user?.role || user?.rol || "").trim().toLowerCase(),
    area: overrides.area || user?.area || getUserCalibrationArea(user),
    participation_status: overrides.participation_status || user?.participation_status || "assigned",
    joined_at: overrides.joined_at || user?.joined_at || "",
    submitted_at: overrides.submitted_at || user?.submitted_at || "",
    is_expert_referent: Boolean(overrides.is_expert_referent || user?.is_expert_referent),
    created_at: overrides.created_at || user?.created_at || nowIso()
  };
}

function buildCalibrationItemRows(evaluationId, sections, evaluationType) {
  return normalizeEvaluationSections(sections, evaluationType).map(section => {
    const result = normalizeCalibrationResult(section.resultado);
    const weight = Number(section.pesoSub || 0) || 0;
    const obtained = result === "cumple" ? weight : 0;
    return {
      id: `${evaluationId}_${getCalibrationSectionKey(section) || generateNumericId()}`,
      calibration_evaluation_id: evaluationId,
      item_id: normalizeText(section.categoria),
      item_name: section.categoria || "",
      subitem_id: getCalibrationSectionKey(section),
      subitem_name: section.nombreSeccion || section.subItem || "",
      result,
      obtained_score: obtained,
      weight,
      comment: section.detalleAuditado || section.comment || "",
      is_critical: false,
      is_zero_tolerance: false,
      created_at: nowIso()
    };
  });
}

function calculateCalibrationScore(sections, zeroToleranceItems, evaluationType) {
  const score = calculateEvaluationScore(sections, evaluationType);
  const appliesZero = normalizeEvaluationFormType(evaluationType) === "mala_practica" ||
    (Array.isArray(zeroToleranceItems) && zeroToleranceItems.some(item => normalizeText(item?.resultado) === "cumple"));
  return {
    ...score,
    pct: appliesZero ? 0 : score.pct,
    text: appliesZero ? "0.0% - Cero tolerancia" : score.text,
    appliesZero
  };
}

function compareCalibrationEvaluation(session, expertEvaluation, participantEvaluation) {
  const evaluationType = session.evaluation_type || "venta";
  const expertSections = normalizeEvaluationSections(expertEvaluation?.sections || expertEvaluation?.secciones || [], evaluationType);
  const participantSections = normalizeEvaluationSections(participantEvaluation?.sections || participantEvaluation?.secciones || [], evaluationType);
  const participantByKey = new Map(participantSections.map(section => [getCalibrationSectionKey(section), section]));
  const comparisonRows = [];
  let matches = 0;
  let compared = 0;
  let criticalMatches = 0;
  let criticalCompared = 0;

  expertSections.forEach(expertSection => {
    const key = getCalibrationSectionKey(expertSection);
    const participantSection = participantByKey.get(key) || {};
    const expertResult = normalizeCalibrationResult(expertSection.resultado);
    const participantResult = normalizeCalibrationResult(participantSection.resultado);
    const weight = Number(expertSection.pesoSub || 0) || 0;
    const expertScore = expertResult === "cumple" ? weight : 0;
    const participantScore = participantResult === "cumple" ? weight : 0;
    const matchStatus = expertResult && participantResult && expertResult === participantResult ? "coincide" : expertResult && participantResult ? "no_coincide" : "parcial";
    if (expertResult || participantResult) {
      compared += 1;
      if (matchStatus === "coincide") matches += 1;
    }
    if (normalizeText(expertSection.categoria).includes("cero") || normalizeText(expertSection.nombreSeccion).includes("tipificacion")) {
      criticalCompared += 1;
      if (matchStatus === "coincide") criticalMatches += 1;
    }
    comparisonRows.push({
      id: `${session.id}_${participantEvaluation.user_id}_${key || comparisonRows.length}`,
      calibration_session_id: session.id,
      item_id: normalizeText(expertSection.categoria),
      subitem_id: key,
      item_name: expertSection.categoria || "",
      subitem_name: expertSection.nombreSeccion || "",
      weight,
      expert_response: expertResult,
      expert_score: expertScore,
      participant_user_id: participantEvaluation.user_id,
      participant_user_name: participantEvaluation.user_name,
      participant_response: participantResult,
      participant_score: participantScore,
      score_difference: participantScore - expertScore,
      match_status: matchStatus,
      expert_comment: expertSection.detalleAuditado || "",
      participant_comment: participantSection.detalleAuditado || "",
      created_at: nowIso()
    });
  });

  const expertScore = Number(expertEvaluation.total_score || 0) || 0;
  const userScore = Number(participantEvaluation.total_score || 0) || 0;
  const scoreDeviation = userScore - expertScore;
  const itemMatchPercentage = compared ? matches / compared * 100 : 0;
  const scoreCloseness = Math.max(0, 100 - Math.abs(scoreDeviation));
  const typificationMatch = normalizeText(participantEvaluation.selected_typification) && normalizeText(participantEvaluation.selected_typification) === normalizeText(expertEvaluation.selected_typification);
  const criticalMatchPercentage = criticalCompared ? criticalMatches / criticalCompared * 100 : itemMatchPercentage;
  const zeroToleranceMatchPercentage = criticalMatchPercentage;
  const affinity = itemMatchPercentage * 0.50 + scoreCloseness * 0.25 + (typificationMatch ? 100 : 0) * 0.15 + criticalMatchPercentage * 0.10;
  const level = affinity >= 90 ? "Muy calibrado" : affinity >= 80 ? "Calibrado" : affinity >= 70 ? "Requiere ajuste" : "No calibrado";
  const mainDifferences = comparisonRows.filter(row => row.match_status !== "coincide").slice(0, 5).map(row => row.subitem_name || row.item_name);

  return {
    result: {
      id: `${session.id}_${participantEvaluation.user_id}`,
      calibration_session_id: session.id,
      user_id: participantEvaluation.user_id,
      user_name: participantEvaluation.user_name,
      role: participantEvaluation.role || "",
      area: participantEvaluation.area || "",
      user_score: userScore,
      expert_score: expertScore,
      score_deviation: scoreDeviation,
      affinity_percentage: Number(affinity.toFixed(1)),
      item_match_percentage: Number(itemMatchPercentage.toFixed(1)),
      subitem_match_percentage: Number(itemMatchPercentage.toFixed(1)),
      typification_match: typificationMatch,
      critical_criteria_match_percentage: Number(criticalMatchPercentage.toFixed(1)),
      zero_tolerance_match_percentage: Number(zeroToleranceMatchPercentage.toFixed(1)),
      calibration_level: level,
      ranking_position: 0,
      main_differences: mainDifferences,
      improvement_opportunities: mainDifferences.map(item => `Reforzar criterio: ${item}`),
      created_at: nowIso()
    },
    comparisonRows
  };
}

async function recomputeCalibrationResults(sessionId) {
  const sessions = await readCalibrationCollection(CALIBRATION_SESSIONS_KEY);
  const session = sessions.find(item => normalizeId(item.id) === normalizeId(sessionId));
  if (!session) throw new Error("No se encontro la calibracion.");
  const evaluations = await readCalibrationCollection(CALIBRATION_EVALUATIONS_KEY);
  const sessionEvaluations = evaluations.filter(item => normalizeId(item.calibration_session_id) === normalizeId(sessionId) && item.submitted);
  const expertId = String(session.expert_referent_id || "").trim();
  const expert = sessionEvaluations.find(item => item.is_expert_referent || String(item.user_id || "") === expertId);
  if (!expert) throw new Error("No se puede cerrar la calibracion: falta la evaluacion del Referente Experto.");
  const participants = sessionEvaluations.filter(item => !item.is_expert_referent && String(item.user_id || "") !== expertId);
  const comparisons = participants.map(item => compareCalibrationEvaluation(session, expert, item));
  const results = comparisons.map(item => item.result).sort((a, b) => b.affinity_percentage - a.affinity_percentage);
  results.forEach((item, index) => { item.ranking_position = index + 1; });
  const allResults = await readCalibrationCollection(CALIBRATION_RESULTS_KEY);
  const allComparisons = await readCalibrationCollection(CALIBRATION_COMPARISON_KEY);
  const nextResults = [
    ...allResults.filter(item => normalizeId(item.calibration_session_id) !== normalizeId(sessionId)),
    ...results
  ];
  const nextComparisons = [
    ...allComparisons.filter(item => normalizeId(item.calibration_session_id) !== normalizeId(sessionId)),
    ...comparisons.flatMap(item => item.comparisonRows)
  ];
  await writeCalibrationCollection(CALIBRATION_RESULTS_KEY, nextResults);
  await writeCalibrationCollection(CALIBRATION_COMPARISON_KEY, nextComparisons);
  return { results, comparisonRows: comparisons.flatMap(item => item.comparisonRows) };
}

function buildTransientCalibrationResults(session, sessionEvaluations, savedResults, savedComparisonRows) {
  const expertId = String(session.expert_referent_id || "").trim();
  const expert = (sessionEvaluations || []).find(item => item.submitted && (item.is_expert_referent || String(item.user_id || "") === expertId));
  if (!expert) return { results: savedResults || [], comparisonRows: savedComparisonRows || [] };
  if ((savedResults || []).length && (savedComparisonRows || []).length) {
    return { results: savedResults, comparisonRows: savedComparisonRows };
  }
  const participantEvaluations = (sessionEvaluations || []).filter(item => (
    item.submitted &&
    !item.is_expert_referent &&
    String(item.user_id || "") !== expertId
  ));
  const comparisons = participantEvaluations.map(item => compareCalibrationEvaluation(session, expert, item));
  const transientResults = comparisons
    .map(item => ({ ...item.result, transient: true }))
    .sort((a, b) => Number(b.affinity_percentage || 0) - Number(a.affinity_percentage || 0));
  transientResults.forEach((item, index) => { item.ranking_position = index + 1; });
  const transientComparisonRows = comparisons.flatMap(item => item.comparisonRows.map(row => ({ ...row, transient: true })));
  return {
    results: (savedResults || []).length ? savedResults : transientResults,
    comparisonRows: (savedComparisonRows || []).length ? savedComparisonRows : transientComparisonRows
  };
}

function getSalesValidationDuplicateKey(record = {}) {
  return [
    normalizeClientId(record.clientId || record.platformId || record.tenantId),
    normalizeText(record.ruc),
    normalizeDateOrNow(record.saleDate || record.fechaVenta || "").slice(0, 10),
    normalizeText(record.callId || record.numeroLlamada || record.interactionId)
  ].join("|");
}

function buildSalesValidationAudit(existing = {}, next = {}, currentUser = {}, action = "updated", extra = {}) {
  const now = nowIso();
  const base = {
    id: normalizeId(generateNumericId()),
    action,
    userId: String(currentUser.usuario || "").trim(),
    userName: String(currentUser.nombre || "").trim(),
    userRole: ROLE_LABELS[getRole(currentUser)] || getRole(currentUser),
    createdAt: now,
    ...extra
  };
  if (action !== "updated") return [base];
  const fields = [
    "ruc", "businessName", "agentName", "agentCode", "saleDate", "campaign", "product",
    "quantity", "callId", "audioStatus", "contractReadingStatus", "omittedContractInfo",
    "observations", "result", "status"
  ];
  return fields
    .filter(field => JSON.stringify(existing?.[field] ?? "") !== JSON.stringify(next?.[field] ?? ""))
    .map(field => ({
      ...base,
      id: normalizeId(generateNumericId()),
      field,
      previousValue: existing?.[field] ?? "",
      newValue: next?.[field] ?? ""
    }));
}

async function readSalesValidations() {
  const records = await readCachedSharedJson(SALES_VALIDATIONS_KEY, []);
  return Array.isArray(records) ? records : [];
}

async function writeSalesValidations(records) {
  await writeSharedRecord(SALES_VALIDATIONS_KEY, Array.isArray(records) ? records : []);
  invalidateFirebaseCache(SALES_VALIDATIONS_KEY);
}

function normalizeSalesValidationPayload(payload = {}, existing = {}, currentUser = {}) {
  const now = nowIso();
  const audioStatus = String(payload.audioStatus || existing.audioStatus || "").trim();
  const contractReadingStatus = String(payload.contractReadingStatus || existing.contractReadingStatus || "").trim();
  const result = String(payload.result || existing.result || "").trim();
  const ruc = String(payload.ruc || existing.ruc || "").trim();
  const businessName = String(payload.businessName || payload.razonSocial || existing.businessName || "").trim();
  const agentName = String(payload.agentName || payload.agenteComercial || existing.agentName || "").trim();
  const saleDate = String(payload.saleDate || payload.fechaVenta || existing.saleDate || "").trim();
  const callId = String(payload.callId || payload.numeroLlamada || payload.interactionId || existing.callId || "").trim();
  const clientId = normalizeClientId(payload.clientId || payload.platformId || payload.tenantId || existing.clientId || existing.platformId || existing.tenantId);
  const clientName = String(payload.clientName || payload.platformName || existing.clientName || existing.platformName || "").trim();
  if (!ruc) throw new Error("El RUC del cliente es obligatorio.");
  if (!businessName) throw new Error("La razon social es obligatoria.");
  if (!agentName) throw new Error("El agente comercial es obligatorio.");
  if (!saleDate) throw new Error("La fecha de venta es obligatoria.");
  if (!audioStatus) throw new Error("Debes indicar si se encontro audio en InConcert.");
  if (!contractReadingStatus) throw new Error("Debes indicar el estado de lectura o confirmacion del contrato.");
  if (!result) throw new Error("El resultado de la validacion es obligatorio.");
  const audioNeedsObservation = normalizeText(audioStatus) !== "si, se encontro audio" && normalizeText(audioStatus) !== "si se encontro audio";
  const observations = String(payload.observations || payload.observaciones || existing.observations || "").trim();
  if (audioNeedsObservation && !observations) throw new Error("La observacion es obligatoria cuando el audio no fue encontrado o presenta incidencias.");
  if (["no", "parcial"].includes(normalizeText(contractReadingStatus)) && !String(payload.omittedContractInfo || existing.omittedContractInfo || "").trim()) {
    throw new Error("Debes detallar la informacion contractual omitida.");
  }
  const id = normalizeId(payload.id || existing.id || generateNumericId());
  const validationDate = existing.validationDate || now;
  return {
    ...existing,
    id,
    clientId,
    platformId: clientId,
    clientName,
    platformName: clientName,
    ruc,
    businessName,
    agentName,
    agentCode: String(payload.agentCode || payload.codigoAgente || existing.agentCode || "").trim(),
    saleDate,
    campaign: String(payload.campaign || payload.campana || existing.campaign || "").trim(),
    product: String(payload.product || payload.producto || existing.product || "").trim(),
    quantity: String(payload.quantity || payload.cantidad || existing.quantity || "").trim(),
    callId,
    audioStatus,
    contractReadingStatus,
    omittedContractInfo: String(payload.omittedContractInfo || existing.omittedContractInfo || "").trim(),
    observations,
    result,
    validatorId: existing.validatorId || String(currentUser.usuario || "").trim(),
    validatorName: existing.validatorName || String(currentUser.nombre || "").trim(),
    validationDate,
    status: existing.status || "Activa",
    files: Array.isArray(existing.files) ? existing.files : [],
    auditTrail: Array.isArray(existing.auditTrail) ? existing.auditTrail : [],
    createdAt: existing.createdAt || now,
    updatedAt: now,
    updatedBy: String(currentUser.usuario || "").trim(),
    updatedByName: String(currentUser.nombre || "").trim()
  };
}

export const gasHandlers = {
  async getData(key) {
    return await readSharedRecord(key);
  },

  async listUsers() {
    const users = await readCachedSharedJson("users_v1", []);
    return Array.isArray(users) ? users : [];
  },

  async saveData(key, value) {
    const result = await writeSharedRecord(key, String(value || ""));
    invalidateFirebaseCache(key);
    return result;
  },

  async deleteData(key) {
    return await deleteSharedRecord(key);
  },

  async listData(prefix = "") {
    const keys = await listSharedKeys(prefix);
    return keys.map(key => ({ key }));
  },

  async getCalibrationData(currentUser = {}) {
    if (!canViewCalibrationModule(currentUser)) throw new Error("No tienes permisos para ver calibraciones.");
    const [sessions, participants, evaluations, evaluationItems, results, comparisonRows, logs] = await Promise.all([
      readCalibrationCollection(CALIBRATION_SESSIONS_KEY),
      readCalibrationCollection(CALIBRATION_PARTICIPANTS_KEY),
      readCalibrationCollection(CALIBRATION_EVALUATIONS_KEY),
      readCalibrationCollection(CALIBRATION_EVALUATION_ITEMS_KEY),
      readCalibrationCollection(CALIBRATION_RESULTS_KEY),
      readCalibrationCollection(CALIBRATION_COMPARISON_KEY),
      readCalibrationCollection(CALIBRATION_ACTIVITY_LOGS_KEY)
    ]);
    const enrichedSessions = sessions
      .map(session => {
        let sessionParticipants = participants.filter(item => normalizeId(item.calibration_session_id) === normalizeId(session.id));
        const expertId = String(session.expert_referent_id || "").trim();
        if (expertId && !sessionParticipants.some(item => String(item.user_id || "") === expertId)) {
          sessionParticipants = [
            buildCalibrationParticipantRecord(session.id, {
              usuario: expertId,
              nombre: session.expert_referent_name || expertId,
              rol: "referente_experto"
            }, { is_expert_referent: true }),
            ...sessionParticipants
          ];
        } else {
          sessionParticipants = sessionParticipants.map(item => String(item.user_id || "") === expertId ? { ...item, is_expert_referent: true } : item);
        }
        const sessionEvaluations = evaluations.filter(item => normalizeId(item.calibration_session_id) === normalizeId(session.id));
        const savedResults = results.filter(item => normalizeId(item.calibration_session_id) === normalizeId(session.id));
        const savedComparisonRows = comparisonRows.filter(item => normalizeId(item.calibration_session_id) === normalizeId(session.id));
        const analytics = buildTransientCalibrationResults(session, sessionEvaluations, savedResults, savedComparisonRows);
        return {
          ...session,
          participants: sessionParticipants,
          evaluations: sessionEvaluations,
          evaluationItems: evaluationItems.filter(item => normalizeId(item.calibration_session_id) === normalizeId(session.id)),
          results: analytics.results,
          comparisonRows: analytics.comparisonRows,
          logs: logs.filter(item => normalizeId(item.calibration_session_id) === normalizeId(session.id))
        };
      })
      .filter(session => canUserSeeCalibration(session, currentUser))
      .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
    return {
      sessions: enrichedSessions,
      participants,
      evaluations,
      evaluationItems,
      results,
      comparisonRows,
      logs
    };
  },

  async saveCalibrationSession(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    if (!canManageCalibration(currentUser)) throw new Error("Solo admin o analista pueden crear calibraciones.");
    const sessions = await readCalibrationCollection(CALIBRATION_SESSIONS_KEY);
    const participants = await readCalibrationCollection(CALIBRATION_PARTICIPANTS_KEY);
    const id = normalizeId(payload.id || payload.calibration_session_id) || String(generateNumericId());
    const existing = sessions.find(item => normalizeId(item.id) === id) || {};
    if (existing.id && ["closed_results", "annulled"].includes(normalizeCalibrationStatus(existing.status)) && getRole(currentUser) !== "admin") {
      throw new Error("Solo un administrador puede corregir una calibracion cerrada o anulada.");
    }
    const rawParticipants = Array.isArray(payload.participants) ? payload.participants : [];
    let selectedParticipants = rawParticipants
      .filter(item => item && String(item.user_id || item.usuario || "").trim())
      .map(item => buildCalibrationParticipantRecord(id, item));
    const expertId = String(payload.expert_referent_id || payload.expertReferentId || "").trim();
    if (expertId && !selectedParticipants.some(item => String(item.user_id) === expertId)) {
      selectedParticipants = [
        buildCalibrationParticipantRecord(id, {
          usuario: expertId,
          nombre: payload.expert_referent_name || existing.expert_referent_name || expertId,
          rol: payload.expert_referent_role || "referente_experto",
          area: payload.expert_referent_area || ""
        }, { is_expert_referent: true }),
        ...selectedParticipants
      ];
    } else {
      selectedParticipants = selectedParticipants.map(item => String(item.user_id) === expertId ? { ...item, is_expert_referent: true } : item);
    }
    const evaluationType = normalizeEvaluationFormType(payload.evaluation_type || payload.audio_type || "venta");
    let session = {
      ...existing,
      id,
      title: String(payload.title || existing.title || "").trim(),
      description: String(payload.description || existing.description || "").trim(),
      calibration_objective: String(payload.calibration_objective || existing.calibration_objective || "").trim(),
      evaluation_type: evaluationType,
      audio_url: payload.audio_url || existing.audio_url || "",
      audio_file: payload.audio_file || existing.audio_file || null,
      call_date: String(payload.call_date || existing.call_date || "").trim(),
      call_time: String(payload.call_time || existing.call_time || "").trim(),
      campaign_name: String(payload.campaign_name || existing.campaign_name || "").trim(),
      evaluated_agent_name: String(payload.evaluated_agent_name || existing.evaluated_agent_name || "").trim(),
      call_identifier: String(payload.call_identifier || existing.call_identifier || "").trim(),
      audio_type: evaluationType,
      call_typification: String(payload.call_typification || existing.call_typification || "").trim(),
      call_result: String(payload.call_result || existing.call_result || "").trim(),
      initial_case_observation: String(payload.initial_case_observation || existing.initial_case_observation || "").trim(),
      scheduled_date: payload.scheduled_date || existing.scheduled_date || "",
      status: normalizeCalibrationStatus(payload.status || existing.status || "draft"),
      created_by: existing.created_by || currentUser.usuario,
      created_by_name: existing.created_by_name || currentUser.nombre,
      expert_referent_id: expertId,
      expert_referent_name: String(payload.expert_referent_name || existing.expert_referent_name || "").trim(),
      created_at: existing.created_at || nowIso(),
      updated_at: nowIso(),
      closed_at: existing.closed_at || ""
    };
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (attachments.length) {
      const storageResult = await uploadAttachmentsWithFirebaseFallback({ id, calibrationId: id, type: "calibration_audio" }, attachments);
      const audioFile = (storageResult.savedFiles || [])[0] || null;
      if (audioFile) {
        session = {
          ...session,
          audio_file: audioFile,
          audio_url: audioFile.previewUrl || audioFile.downloadUrl || audioFile.publicUrl || audioFile.url || "",
          storageWarning: storageResult.storageWarning || ""
        };
      }
    }
    const nextSessions = upsertById(sessions, session);
    const nextParticipants = [
      ...participants.filter(item => normalizeId(item.calibration_session_id) !== id),
      ...selectedParticipants
    ];
    await writeCalibrationCollection(CALIBRATION_SESSIONS_KEY, nextSessions);
    await writeCalibrationCollection(CALIBRATION_PARTICIPANTS_KEY, nextParticipants);
    await addCalibrationLog(id, currentUser, existing.id ? "session_updated" : "session_created", existing.id ? "Se actualizo la calibracion." : "Se creo la calibracion.");
    return { ...session, participants: selectedParticipants };
  },

  async deleteCalibrationSession(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    requireRoles(currentUser, ["admin"], "Solo un administrador puede eliminar calibraciones.");
    const id = normalizeId(payload.id || payload.calibration_session_id);
    if (!id) throw new Error("Id de calibracion requerido.");
    const collections = await Promise.all([
      readCalibrationCollection(CALIBRATION_SESSIONS_KEY),
      readCalibrationCollection(CALIBRATION_PARTICIPANTS_KEY),
      readCalibrationCollection(CALIBRATION_EVALUATIONS_KEY),
      readCalibrationCollection(CALIBRATION_EVALUATION_ITEMS_KEY),
      readCalibrationCollection(CALIBRATION_RESULTS_KEY),
      readCalibrationCollection(CALIBRATION_COMPARISON_KEY),
      readCalibrationCollection(CALIBRATION_ACTIVITY_LOGS_KEY)
    ]);
    const [sessions, participants, evaluations, evaluationItems, results, comparisonRows, logs] = collections;
    const session = sessions.find(item => normalizeId(item.id) === id);
    if (!session) throw new Error("No se encontro la calibracion.");
    await Promise.all([
      writeCalibrationCollection(CALIBRATION_SESSIONS_KEY, sessions.filter(item => normalizeId(item.id) !== id)),
      writeCalibrationCollection(CALIBRATION_PARTICIPANTS_KEY, participants.filter(item => normalizeId(item.calibration_session_id) !== id)),
      writeCalibrationCollection(CALIBRATION_EVALUATIONS_KEY, evaluations.filter(item => normalizeId(item.calibration_session_id) !== id)),
      writeCalibrationCollection(CALIBRATION_EVALUATION_ITEMS_KEY, evaluationItems.filter(item => normalizeId(item.calibration_session_id) !== id)),
      writeCalibrationCollection(CALIBRATION_RESULTS_KEY, results.filter(item => normalizeId(item.calibration_session_id) !== id)),
      writeCalibrationCollection(CALIBRATION_COMPARISON_KEY, comparisonRows.filter(item => normalizeId(item.calibration_session_id) !== id)),
      writeCalibrationCollection(CALIBRATION_ACTIVITY_LOGS_KEY, logs.filter(item => normalizeId(item.calibration_session_id) !== id))
    ]);
    return { ok: true, id, title: session.title || "" };
  },

  async updateCalibrationStatus(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    if (!canManageCalibration(currentUser)) throw new Error("Solo admin o analista pueden cambiar el estado de una calibracion.");
    const id = normalizeId(payload.id || payload.calibration_session_id);
    if (!id) throw new Error("Id de calibracion requerido.");
    const sessions = await readCalibrationCollection(CALIBRATION_SESSIONS_KEY);
    const session = sessions.find(item => normalizeId(item.id) === id);
    if (!session) throw new Error("No se encontro la calibracion.");
    const nextStatus = normalizeCalibrationStatus(payload.status);
    if (nextStatus === "live") {
      let sessionParticipants = (await readCalibrationCollection(CALIBRATION_PARTICIPANTS_KEY)).filter(item => normalizeId(item.calibration_session_id) === id);
      const expertId = String(session.expert_referent_id || "").trim();
      if (expertId && !sessionParticipants.some(item => String(item.user_id || "") === expertId)) {
        sessionParticipants = [buildCalibrationParticipantRecord(id, { usuario: expertId, nombre: session.expert_referent_name || expertId, rol: "referente_experto" }, { is_expert_referent: true }), ...sessionParticipants];
      }
      validateCalibrationCanStart({ ...session, participants: sessionParticipants });
    }
    let resultsPayload = null;
    if (nextStatus === "closed_results") {
      resultsPayload = await recomputeCalibrationResults(id);
    }
    const updated = {
      ...session,
      status: nextStatus,
      updated_at: nowIso(),
      closed_at: nextStatus === "closed_results" ? nowIso() : session.closed_at || ""
    };
    await writeCalibrationCollection(CALIBRATION_SESSIONS_KEY, upsertById(sessions, updated));
    await addCalibrationLog(id, currentUser, `status_${nextStatus}`, `Estado actualizado a ${nextStatus}.`);
    return { ...updated, ...(resultsPayload || {}) };
  },

  async submitCalibrationEvaluation(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    const sessionId = normalizeId(payload.calibration_session_id || payload.sessionId);
    if (!sessionId) throw new Error("Id de calibracion requerido.");
    const sessions = await readCalibrationCollection(CALIBRATION_SESSIONS_KEY);
    const session = sessions.find(item => normalizeId(item.id) === sessionId);
    if (!session) throw new Error("No se encontro la calibracion.");
    const status = normalizeCalibrationStatus(session.status);
    if (status !== "live") throw new Error("Solo se puede enviar una evaluacion cuando la calibracion esta En vivo.");
    const participants = await readCalibrationCollection(CALIBRATION_PARTICIPANTS_KEY);
    const userId = String(currentUser.usuario || "").trim();
    const isExpert = String(session.expert_referent_id || "") === userId;
    const assigned = participants.find(item => normalizeId(item.calibration_session_id) === sessionId && String(item.user_id) === userId);
    if (!isExpert && !assigned && !canManageCalibration(currentUser)) throw new Error("No estas asignado a esta calibracion.");
    const evaluations = await readCalibrationCollection(CALIBRATION_EVALUATIONS_KEY);
    const existing = evaluations.find(item => normalizeId(item.calibration_session_id) === sessionId && String(item.user_id) === userId);
    if (existing?.locked && !canManageCalibration(currentUser)) throw new Error("Tu evaluacion ya fue enviada y esta bloqueada.");
    const evaluationId = existing?.id || `${sessionId}_${userId}`;
    const score = calculateCalibrationScore(payload.sections || payload.secciones || [], payload.zeroToleranceItems || [], session.evaluation_type);
    const normalizedEvaluation = {
      ...(existing || {}),
      id: evaluationId,
      calibration_session_id: sessionId,
      user_id: userId,
      user_name: currentUser.nombre || payload.user_name || "",
      role: getRole(currentUser),
      area: getUserCalibrationArea(currentUser),
      is_expert_referent: Boolean(isExpert),
      total_score: Number(score.pct.toFixed(1)),
      selected_typification: String(payload.selected_typification || payload.typification || "").trim(),
      general_observation: String(payload.general_observation || "").trim(),
      sections: normalizeEvaluationSections(payload.sections || payload.secciones || [], session.evaluation_type),
      zeroToleranceItems: Array.isArray(payload.zeroToleranceItems) ? payload.zeroToleranceItems : [],
      submitted: true,
      submitted_at: nowIso(),
      locked: true,
      created_at: existing?.created_at || nowIso(),
      updated_at: nowIso()
    };
    await writeCalibrationCollection(CALIBRATION_EVALUATIONS_KEY, upsertById(evaluations, normalizedEvaluation));
    const allEvaluationItems = await readCalibrationCollection(CALIBRATION_EVALUATION_ITEMS_KEY);
    const itemRows = buildCalibrationItemRows(evaluationId, normalizedEvaluation.sections, session.evaluation_type).map(item => ({
      ...item,
      calibration_session_id: sessionId,
      user_id: userId,
      is_expert_referent: Boolean(isExpert)
    }));
    await writeCalibrationCollection(CALIBRATION_EVALUATION_ITEMS_KEY, [
      ...allEvaluationItems.filter(item => normalizeId(item.calibration_evaluation_id) !== normalizeId(evaluationId)),
      ...itemRows
    ]);
    const nextParticipants = participants.map(item => normalizeId(item.calibration_session_id) === sessionId && String(item.user_id) === userId
      ? { ...item, participation_status: "submitted", submitted_at: normalizedEvaluation.submitted_at }
      : item
    );
    await writeCalibrationCollection(CALIBRATION_PARTICIPANTS_KEY, nextParticipants);
    await addCalibrationLog(sessionId, currentUser, "evaluation_submitted", `${currentUser.nombre || userId} envio su evaluacion de calibracion.`);
    return { ...normalizedEvaluation, items: itemRows };
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
      operationalIncidents,
      communications,
      chatMessages
    ] = await Promise.all([
      readCachedSharedJson("users_v1", []),
      readCachedSharedJson("snapshots_shared", []),
      readCachedSharedJson("staffing", []),
      readCachedSharedJson(FEEDBACK_KEY, []),
      readEvaluationRecordsFromFirebase(),
      readCachedSharedJson("notip_records_v1", []),
      readCachedSharedJson("legend_concepts_v1", []),
      readCachedSharedJson(OPERATIONAL_INCIDENTS_KEY, []),
      readCachedSharedJson(COMMUNICATIONS_KEY, []),
      readCachedSharedJson("internal_chat_v1", [])
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
      operationalIncidents: Array.isArray(operationalIncidents) ? operationalIncidents : [],
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
      operationalIncidents: result.operationalIncidents.length,
      communications: result.communications.length,
      chatMessages: result.chatMessages.length
    };
    return result;
  },

  async getImprovementDashboardDataFast() {
    const [
      historico,
      staffing,
      feedbackRecords,
      evaluationRecords,
      noTipificationRecords,
      legendConcepts
    ] = await Promise.all([
      readCachedSharedJson("snapshots_shared", []),
      readCachedSharedJson("staffing", []),
      readCachedSharedJson(FEEDBACK_KEY, []),
      readEvaluationRecordsFromFirebase(),
      readCachedSharedJson("notip_records_v1", []),
      readCachedSharedJson("legend_concepts_v1", [])
    ]);
    const result = {
      ok: true,
      source: "local_node_firebase_fast",
      historico: Array.isArray(historico) ? historico : [],
      staffing: Array.isArray(staffing) ? staffing : [],
      feedbackRecords: Array.isArray(feedbackRecords) ? feedbackRecords : [],
      evaluationRecords: Array.isArray(evaluationRecords) ? evaluationRecords : [],
      noTipificationRecords: Array.isArray(noTipificationRecords) ? noTipificationRecords : [],
      legendConcepts: Array.isArray(legendConcepts) ? legendConcepts : [],
      errors: {}
    };
    result.counts = {
      historico: result.historico.length,
      staffing: result.staffing.length,
      feedbackRecords: result.feedbackRecords.length,
      evaluationRecords: result.evaluationRecords.length,
      noTipificationRecords: result.noTipificationRecords.length,
      legendConcepts: result.legendConcepts.length
    };
    return result;
  },

  async validateDatabaseHealth() {
    const startedAt = Date.now();
    const [
      users,
      historico,
      staffing,
      feedbackRecords,
      evaluationRecords,
      noTipificationRecords,
      legendConcepts,
      operationalIncidents,
      communications,
      chatMessages,
      calibrationSessions,
      calibrationParticipants,
      calibrationEvaluations,
      calibrationEvaluationItems,
      calibrationResults,
      calibrationComparisonRows,
      calibrationLogs
    ] = await Promise.all([
      readCachedSharedJson("users_v1", []),
      readCachedSharedJson("snapshots_shared", []),
      readCachedSharedJson("staffing", []),
      readCachedSharedJson(FEEDBACK_KEY, []),
      readEvaluationRecordsFromFirebase(),
      readCachedSharedJson("notip_records_v1", []),
      readCachedSharedJson("legend_concepts_v1", []),
      readCachedSharedJson(OPERATIONAL_INCIDENTS_KEY, []),
      readCachedSharedJson(COMMUNICATIONS_KEY, []),
      readCachedSharedJson("internal_chat_v1", []),
      readCalibrationCollection(CALIBRATION_SESSIONS_KEY),
      readCalibrationCollection(CALIBRATION_PARTICIPANTS_KEY),
      readCalibrationCollection(CALIBRATION_EVALUATIONS_KEY),
      readCalibrationCollection(CALIBRATION_EVALUATION_ITEMS_KEY),
      readCalibrationCollection(CALIBRATION_RESULTS_KEY),
      readCalibrationCollection(CALIBRATION_COMPARISON_KEY),
      readCalibrationCollection(CALIBRATION_ACTIVITY_LOGS_KEY)
    ]);
    const counts = {
      users: Array.isArray(users) ? users.length : 0,
      historico: Array.isArray(historico) ? historico.length : 0,
      staffing: Array.isArray(staffing) ? staffing.length : 0,
      feedbackRecords: Array.isArray(feedbackRecords) ? feedbackRecords.length : 0,
      evaluationRecords: Array.isArray(evaluationRecords) ? evaluationRecords.length : 0,
      noTipificationRecords: Array.isArray(noTipificationRecords) ? noTipificationRecords.length : 0,
      legendConcepts: Array.isArray(legendConcepts) ? legendConcepts.length : 0,
      operationalIncidents: Array.isArray(operationalIncidents) ? operationalIncidents.length : 0,
      communications: Array.isArray(communications) ? communications.length : 0,
      chatMessages: Array.isArray(chatMessages) ? chatMessages.length : 0,
      calibrationSessions: Array.isArray(calibrationSessions) ? calibrationSessions.length : 0,
      calibrationParticipants: Array.isArray(calibrationParticipants) ? calibrationParticipants.length : 0,
      calibrationEvaluations: Array.isArray(calibrationEvaluations) ? calibrationEvaluations.length : 0,
      calibrationEvaluationItems: Array.isArray(calibrationEvaluationItems) ? calibrationEvaluationItems.length : 0,
      calibrationResults: Array.isArray(calibrationResults) ? calibrationResults.length : 0,
      calibrationComparisonRows: Array.isArray(calibrationComparisonRows) ? calibrationComparisonRows.length : 0,
      calibrationLogs: Array.isArray(calibrationLogs) ? calibrationLogs.length : 0
    };
    return {
      ok: true,
      source: "firebase_realtime_database",
      elapsedMs: Date.now() - startedAt,
      counts
    };
  },

  async listNoTipificationRecords() {
    const records = await readCachedSharedJson("notip_records_v1", []);
    return Array.isArray(records) ? records : [];
  },

  async saveNoTipificationRecord(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    requireRoles(currentUser, ["admin", "analista", "supervisor", "formador"], "No tienes permisos para registrar no tipificacion.");
    const advisorName = String(payload.asesorNombre || payload.advisorName || payload.asesor || "").trim();
    if (!advisorName) throw new Error("El asesor es obligatorio.");
    const phoneNumber = String(payload.phoneNumber || payload.phone_number || payload.telefono || "").trim();
    if (!phoneNumber) throw new Error("El numero de telefono es obligatorio.");
    const callDateTime = payload.callDateTime || payload.call_date_time || payload.fechaLlamada || "";
    if (!String(callDateTime || "").trim()) throw new Error("La fecha y hora de la llamada es obligatoria.");
    const callDuration = String(payload.callDuration || payload.call_duration || payload.duracion || "").trim();
    if (!callDuration) throw new Error("La duracion de la llamada es obligatoria.");
    const now = nowIso();
    const records = await readCachedSharedJson("notip_records_v1", []);
    const record = {
      id: normalizeId(payload.id || generateNumericId()),
      asesorNombre: advisorName,
      advisorUser: String(payload.advisorUser || payload.advisor_id || "").trim(),
      supervisor: String(payload.supervisor || "").trim(),
      coordinador: String(payload.coordinador || "").trim(),
      antiguedad: Number(payload.antiguedad || 0) || 0,
      fechaIngreso: String(payload.fechaIngreso || "").trim(),
      clientId: normalizeClientId(payload.clientId || payload.platformId || payload.tenantId),
      platformId: normalizeClientId(payload.platformId || payload.clientId || payload.tenantId),
      clientName: String(payload.clientName || payload.platformName || "").trim(),
      platformName: String(payload.platformName || payload.clientName || "").trim(),
      managementTypeRuc: String(payload.managementTypeRuc || payload.campaign_name || payload.campana || "").trim(),
      phoneNumber,
      callDateTime: new Date(callDateTime).toString() === "Invalid Date" ? callDateTime : new Date(callDateTime).toISOString(),
      callDuration,
      incidentType: "No tipificacion",
      incidentCategory: "Incidencia operativa",
      status: "Registrado",
      createdBy: String(currentUser.usuario || "").trim(),
      createdByName: String(currentUser.nombre || "").trim(),
      createdAt: payload.createdAt || now,
      updatedAt: now
    };
    const nextRecords = [record, ...(Array.isArray(records) ? records : [])];
    await writeSharedRecord("notip_records_v1", nextRecords);
    invalidateFirebaseCache("notip_records_v1");
    return record;
  },

  async listOperationalIncidents() {
    const records = await readCachedSharedJson(OPERATIONAL_INCIDENTS_KEY, []);
    return Array.isArray(records) ? records : [];
  },

  async saveOperationalIncident(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    requireRoles(currentUser, ["admin", "analista", "supervisor", "formador"], "No tienes permisos para registrar incidencias operativas.");
    const advisorName = String(payload.advisor_name || payload.advisorName || payload.asesorNombre || payload.asesor || "").trim();
    if (!advisorName) throw new Error("El asesor o ejecutivo relacionado es obligatorio.");
    const observation = String(payload.observation || payload.observacion || "").trim()
      || "No se encuentra audio disponible en inConcert para realizar la evaluación de calidad. Se registra la incidencia operativa 'No conectado' para seguimiento correspondiente.";
    const now = nowIso();
    const records = await readCachedSharedJson(OPERATIONAL_INCIDENTS_KEY, []);
    const clientId = normalizeClientId(payload.clientId || payload.platformId || payload.tenantId);
    const clientName = String(payload.clientName || payload.platformName || "").trim();
    const record = {
      id: normalizeId(payload.id || generateNumericId()),
      clientId,
      platformId: clientId,
      clientName,
      platformName: clientName,
      advisor_id: String(payload.advisor_id || payload.advisorUser || "").trim(),
      advisor_name: advisorName,
      monitor_id: String(currentUser.usuario || payload.monitor_id || "").trim(),
      monitor_name: String(currentUser.nombre || payload.monitor_name || "").trim(),
      campaign_id: String(payload.campaign_id || "").trim(),
      campaign_name: String(payload.campaign_name || payload.campaignName || payload.campana || "").trim(),
      call_id: String(payload.call_id || payload.callId || payload.case_id || payload.caseId || "").trim(),
      incident_type: "No conectado",
      incident_category: "Incidencia operativa",
      observation,
      status: "Registrado",
      created_at: payload.created_at || now,
      updated_at: now
    };
    const nextRecords = [record, ...(Array.isArray(records) ? records : [])];
    await writeSharedRecord(OPERATIONAL_INCIDENTS_KEY, nextRecords);
    invalidateFirebaseCache(OPERATIONAL_INCIDENTS_KEY);
    return record;
  },

  async listSalesValidations(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    if (!canViewSalesValidation(currentUser)) throw new Error("No tienes permisos para ver validaciones de ventas.");
    const records = await readSalesValidations();
    const role = getRole(currentUser);
    return records
      .filter(record => role === "admin" ? true : normalizeText(record?.status) !== "eliminada")
      .sort((a, b) => new Date(b.updatedAt || b.validationDate || 0).getTime() - new Date(a.updatedAt || a.validationDate || 0).getTime());
  },

  async saveSalesValidation(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    if (!canManageSalesValidation(currentUser)) throw new Error("No tienes permisos para registrar validaciones de ventas.");
    const records = await readSalesValidations();
    const id = payload.id ? normalizeId(payload.id) : "";
    const index = id ? records.findIndex(item => normalizeId(item?.id) === id) : -1;
    const existing = index >= 0 ? records[index] : {};
    const normalized = normalizeSalesValidationPayload(payload, existing, currentUser);
    const duplicateKey = getSalesValidationDuplicateKey(normalized);
    const duplicated = records.find(item =>
      normalizeId(item?.id) !== normalizeId(normalized.id) &&
      normalizeText(item?.status) !== "eliminada" &&
      getSalesValidationDuplicateKey(item) === duplicateKey
    );
    if (duplicated) throw new Error("Ya existe una validacion para el mismo RUC, fecha de venta y numero de llamada.");

    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    let record = normalized;
    if (attachments.length) {
      const storageResult = await uploadAttachmentsWithFirebaseFallback(
        { id: record.id, salesValidationId: record.id, type: "sales_validation" },
        attachments
      );
      record = buildFileFieldsFromSavedFiles(
        record,
        mergeFilesByIdentity(record.files, storageResult.savedFiles || []),
        storageResult
      );
      record.attachmentStatus = storageResult.ok ? "completo" : "pendiente";
    }

    const action = index >= 0 ? "updated" : "created";
    const auditEntries = action === "created"
      ? buildSalesValidationAudit({}, record, currentUser, "created")
      : buildSalesValidationAudit(existing, record, currentUser, "updated");
    record.auditTrail = [...(Array.isArray(existing.auditTrail) ? existing.auditTrail : []), ...auditEntries];
    const nextRecords = index >= 0
      ? records.map(item => normalizeId(item?.id) === normalizeId(record.id) ? record : item)
      : [record, ...records];
    await writeSalesValidations(nextRecords);
    return record;
  },

  async deleteSalesValidation(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    if (!canDeleteSalesValidation(currentUser)) throw new Error("Solo el administrador puede eliminar validaciones de ventas.");
    const id = normalizeId(payload.id);
    const reason = String(payload.reason || payload.motivo || "").trim();
    if (!id) throw new Error("El id de la validacion es obligatorio.");
    if (!reason) throw new Error("El motivo de eliminacion es obligatorio.");
    const records = await readSalesValidations();
    const index = records.findIndex(item => normalizeId(item?.id) === id);
    if (index < 0) throw new Error("No se encontro la ficha de validacion.");
    const now = nowIso();
    const existing = records[index];
    const record = {
      ...existing,
      status: "Eliminada",
      deletedAt: now,
      deletedBy: String(currentUser.usuario || "").trim(),
      deletedByName: String(currentUser.nombre || "").trim(),
      deleteReason: reason,
      updatedAt: now,
      updatedBy: String(currentUser.usuario || "").trim(),
      updatedByName: String(currentUser.nombre || "").trim(),
      auditTrail: [
        ...(Array.isArray(existing.auditTrail) ? existing.auditTrail : []),
        ...buildSalesValidationAudit(existing, existing, currentUser, "deleted", { reason })
      ]
    };
    const nextRecords = records.map(item => normalizeId(item?.id) === id ? record : item);
    await writeSalesValidations(nextRecords);
    return record;
  },

  async restoreSalesValidation(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    requireRoles(currentUser, ["admin"], "Solo el administrador puede restaurar validaciones.");
    const id = normalizeId(payload.id);
    const records = await readSalesValidations();
    const index = records.findIndex(item => normalizeId(item?.id) === id);
    if (index < 0) throw new Error("No se encontro la ficha de validacion.");
    const now = nowIso();
    const existing = records[index];
    const record = {
      ...existing,
      status: "Activa",
      restoredAt: now,
      restoredBy: String(currentUser.usuario || "").trim(),
      restoredByName: String(currentUser.nombre || "").trim(),
      updatedAt: now,
      updatedBy: String(currentUser.usuario || "").trim(),
      updatedByName: String(currentUser.nombre || "").trim(),
      auditTrail: [
        ...(Array.isArray(existing.auditTrail) ? existing.auditTrail : []),
        ...buildSalesValidationAudit(existing, existing, currentUser, "restored")
      ]
    };
    const nextRecords = records.map(item => normalizeId(item?.id) === id ? record : item);
    await writeSalesValidations(nextRecords);
    return record;
  },

  async listLegendConcepts() {
    const records = await readCachedSharedJson("legend_concepts_v1", []);
    return Array.isArray(records) ? records : [];
  },

  async listInternalChatMessages() {
    const records = await readCachedSharedJson("internal_chat_v1", []);
    return Array.isArray(records) ? records : [];
  },

  async saveInternalChatMessage(payload = {}) {
    const text = String(payload.text || "").trim();
    if (!text) throw new Error("El mensaje del chat no puede estar vacio.");
    const now = nowIso();
    const records = await readCachedSharedJson("internal_chat_v1", []);
    const record = {
      id: String(payload.id || `chat_${generateNumericId()}`),
      text: text.slice(0, 5000),
      authorName: String(payload.authorName || "Usuario").trim(),
      authorUser: String(payload.authorUser || "").trim(),
      authorRole: String(payload.authorRole || "").trim(),
      createdAt: String(payload.createdAt || now),
      updatedAt: now
    };
    const nextRecords = [record, ...(Array.isArray(records) ? records : [])]
      .sort((a, b) => new Date(b?.createdAt || 0) - new Date(a?.createdAt || 0))
      .slice(0, 300);
    await writeSharedRecord("internal_chat_v1", nextRecords);
    invalidateFirebaseCache("internal_chat_v1");
    return record;
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
      clientId: String(payload.clientId || payload.platformId || existing?.clientId || existing?.platformId || "").trim(),
      platformId: String(payload.platformId || payload.clientId || existing?.platformId || existing?.clientId || "").trim(),
      clientName: String(payload.clientName || existing?.clientName || "").trim(),
      platformName: String(payload.platformName || payload.clientName || existing?.platformName || existing?.clientName || "").trim(),
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
    const records = await readFeedbackRecords();
    const existingIndex = records.findIndex(item => Number(item?.id) === id);
    const existing = existingIndex >= 0 ? records[existingIndex] : null;
    if (existing && String(existing.estado || existing.status || "") === "closed" && getRole(currentUser) !== "admin") {
      throw new Error("Solo un administrador puede corregir un feedback cerrado.");
    }
    const now = nowIso();
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const record = {
      ...(existing || {}),
      ...sanitizeRuntimePayload(payload),
      id,
      asesorId: String(payload.asesorId || payload.advisorUser || assessor).trim(),
      assessor,
      asesorNombre: assessor,
      auditorId: String(existing?.auditorId || payload.auditorId || currentUser.usuario || "").trim(),
      auditorNombre: String(existing?.auditorNombre || payload.authorName || currentUser.nombre || "").trim(),
      authorName: String(existing?.authorName || payload.authorName || currentUser.nombre || "").trim(),
      authorUser: String(existing?.authorUser || payload.authorUser || currentUser.usuario || "").trim(),
      authorRole: String(existing?.authorRole || payload.authorRole || ROLE_LABELS[getRole(currentUser)] || getRole(currentUser)).trim(),
      advisorUser: String(payload.advisorUser || "").trim(),
      supervisorName: String(payload.supervisorName || payload.supervisor || "").trim(),
      supervisor: String(payload.supervisor || payload.supervisorName || "").trim(),
      supervisorUser: String(payload.supervisorUser || "").trim(),
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
      status: existing?.status || normalizeFeedbackStatusForSave(payload.advisorUser),
      estado: existing?.estado || normalizeFeedbackStatusForSave(payload.advisorUser),
      files: Array.isArray(payload.files) ? payload.files : (existing?.files || []),
      messages: Array.isArray(existing?.messages) ? existing.messages : [],
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      updatedBy: String(currentUser.usuario || "").trim(),
      updatedByName: String(currentUser.nombre || "").trim()
    };

    if (existingIndex >= 0) records[existingIndex] = record;
    else records.unshift(record);
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

  async deleteFeedbackRecord(payload = {}) {
    const currentUser = ensureCurrentUser(payload.currentUser);
    requireRoles(currentUser, ["admin"], "Solo un administrador puede eliminar fichas de feedback.");
    const id = Number(payload.id);
    if (!id) throw new Error("El id del feedback es obligatorio.");
    const records = await readFeedbackRecords();
    const record = records.find(item => Number(item?.id) === id);
    if (!record) throw new Error("No se encontro el feedback solicitado.");
    await writeFeedbackRecords(records.filter(item => Number(item?.id) !== id));
    return { ok: true, id };
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

    const feedbackIsClosed = normalizeText(record.estado || record.status || "") === "closed";
    const role = getRole(currentUser);
    if (feedbackIsClosed && role !== "admin") {
      throw new Error("Este feedback ya fue cerrado por supervisor. Solo un administrador puede modificarlo.");
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
      if (isFeedbackAdvisorValidated(record) && record.estado !== "viewed" && record.estado !== "pending" && record.estado !== "in_follow_up") {
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
      requireRoles(currentUser, ["admin", "analista"], "Solo administradores y analistas pueden reactivar el feedback en seguimiento.");
      appendFeedbackThreadMessage(record, {
        text: "El feedback fue reactivado en seguimiento. Se requiere una nueva validacion del asesor.",
        authorName: actorName,
        authorUser: actorUser,
        authorRole: actorRole
      });
      record.advisorValidationStatus = "";
      record.advisorDecision = "";
      record.advisorValidationComment = "";
      record.advisorValidatedAt = "";
      record.advisorValidatedBy = "";
      record.advisorValidatedName = "";
      record.advisorAcceptedAt = "";
      record.advisorAcceptedBy = "";
      record.advisorAcceptedName = "";
      record.comentarioAsesor = "";
      record.fechaVisualizacionAsesor = "";
      if (feedbackIsClosed && role === "admin") {
        record.supervisorValidationComment = "";
        record.supervisorValidatedAt = "";
        record.supervisorValidatedBy = "";
        record.supervisorValidatedName = "";
      }
      record.estado = "in_follow_up";
      record.status = "in_follow_up";
    }

    if (action === "close_feedback") {
      requireRoles(currentUser, ["supervisor"], "Solo el supervisor puede cerrar la validacion final del feedback.");
      if (!isFeedbackAssignedToSupervisor(record, currentUser)) {
        throw new Error("Este feedback esta asignado a otro supervisor.");
      }
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
    const deletedIds = new Set((await readCachedSharedJson(DELETED_EVALUATIONS_KEY, []) || []).map(item => normalizeId(item?.id || item?.idEvaluacion || item)).filter(Boolean));
    if (deletedIds.has(normalizeId(id))) return null;
    const key = getEvaluationRecordKey(id);
    const detail = await readCachedSharedJson(key, null);
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
    const compact = await readCachedSharedJson(EVALUATIONS_KEY, []);
    const nextCompact = Array.isArray(compact)
      ? compact.filter(item => normalizeId(item?.id || item?.idEvaluacion) !== id)
      : [];
    const deleted = await readCachedSharedJson(DELETED_EVALUATIONS_KEY, []);
    const deletedList = Array.isArray(deleted) ? deleted : [];
    const deletedExists = deletedList.some(item => normalizeId(item?.id || item?.idEvaluacion || item) === id);
    const nextDeleted = deletedExists
      ? deletedList
      : [{ id, deletedAt: nowIso(), deletedBy: String(currentUser.usuario || "").trim() }, ...deletedList];
    await deleteSharedRecord(getEvaluationRecordKey(id));
    await writeSharedRecord(EVALUATIONS_KEY, nextCompact);
    await writeSharedRecord(DELETED_EVALUATIONS_KEY, nextDeleted);
    invalidateFirebaseCache(EVALUATIONS_KEY, DELETED_EVALUATIONS_KEY, getEvaluationRecordKey(id));
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
