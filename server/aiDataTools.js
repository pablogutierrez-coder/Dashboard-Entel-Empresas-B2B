import { readSharedJson } from "./firebase.js";

const COLLECTIONS = {
  evaluations: {
    key: "evaluations_v1",
    label: "Evaluaciones de calidad",
    aliases: ["evaluaciones", "evaluacion", "calidad", "quality"]
  },
  feedback: {
    key: "feedback_records_v2",
    label: "Feedbacks",
    aliases: ["feedback", "retroalimentaciones", "seguimiento"]
  },
  incidents: {
    key: "operational_incidents_v1",
    label: "Incidencias operativas",
    aliases: ["incidencias", "incidentes", "no conectado", "no tipificacion"]
  },
  no_tipification: {
    key: "notip_records_v1",
    label: "No tipificacion",
    aliases: ["no tipificacion", "no_tipificacion", "alertas"]
  },
  sales_validations: {
    key: "sales_validations_v1",
    label: "Validaciones de ventas",
    aliases: ["validacion de ventas", "ventas", "validaciones comerciales"]
  },
  calibration_sessions: {
    key: "calibration_sessions",
    label: "Sesiones de calibracion",
    aliases: ["calibraciones", "calibracion"]
  },
  calibration_results: {
    key: "calibration_results",
    label: "Resultados de calibracion",
    aliases: ["resultados calibracion", "afinidad"]
  },
  staffing: {
    key: "staffing",
    label: "Dotacion",
    aliases: ["dotacion", "asesores", "staffing"]
  },
  users: {
    key: "users_v1",
    label: "Usuarios",
    aliases: ["usuarios", "users"]
  },
  communications: {
    key: "communications_v1",
    label: "Comunicados",
    aliases: ["comunicados", "communications"]
  }
};

const MAX_RECORDS_RETURNED = 40;
const MAX_RECORD_CHARS = 3200;
const LIMIT_PARAMETER_SCHEMA = {
  anyOf: [{ type: "number" }, { type: "string" }],
  description: "Maximo a devolver. Puede llegar como numero o texto; el backend lo normaliza."
};

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
}

function compactValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 240)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= 2) return `[${value.length} items]`;
    return value.slice(0, 8).map(item => compactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 2) return "{...}";
    const blockedKeys = new Set(["password", "contrasena", "base64", "dataUrl", "data_url", "blob", "bytes"]);
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !blockedKeys.has(normalizeText(key)))
        .slice(0, 28)
        .map(([key, item]) => [key, compactValue(item, depth + 1)])
    );
  }
  return String(value);
}

function clampLimit(limit, fallback = 20) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_RECORDS_RETURNED, Math.max(1, Math.floor(parsed)));
}

function normalizeId(value) {
  return String(value ?? "").trim();
}

function extractPercent(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = String(value ?? "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = String(value || "").trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const parsed = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const latam = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (latam) {
    const year = Number(latam[3].length === 2 ? `20${latam[3]}` : latam[3]);
    const parsed = new Date(year, Number(latam[2]) - 1, Number(latam[1]));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateOnly(value) {
  const date = parseDateValue(value);
  if (!date) return String(value || "");
  return date.toISOString().slice(0, 10);
}

function monthsBetween(startDate, endDate = new Date()) {
  if (!startDate) return null;
  const months = (endDate.getFullYear() - startDate.getFullYear()) * 12 + (endDate.getMonth() - startDate.getMonth());
  const adjusted = endDate.getDate() < startDate.getDate() ? months - 1 : months;
  return Math.max(0, adjusted);
}

function isActiveStaffing(row) {
  const state = normalizeText(row?.estado || row?.status || row?.state || "activo");
  return !["cesado", "inactivo", "baja", "eliminado", "inactive"].includes(state);
}

async function getDeletedEvaluationIds() {
  const deleted = await readSharedJson("deleted_evaluations_v1", []);
  const values = Array.isArray(deleted)
    ? deleted
    : deleted && typeof deleted === "object"
      ? Object.values(deleted)
      : [];
  return new Set(values.flatMap(item => {
    if (item === null || item === undefined) return [];
    if (typeof item === "string" || typeof item === "number") return [normalizeId(item)];
    if (typeof item === "object") return [item.id, item.idEvaluacion, item.evaluationId, item.deletedId].map(normalizeId).filter(Boolean);
    return [];
  }).filter(Boolean));
}

function isDeletedEvaluation(row, deletedIds) {
  if (!row || typeof row !== "object") return false;
  if (row.deleted || row.isDeleted || normalizeText(row.estado) === "eliminado") return true;
  const ids = [row.id, row.idEvaluacion, row.evaluationId, row.feedbackId].map(normalizeId).filter(Boolean);
  return ids.some(id => deletedIds.has(id));
}

function getEvaluationScore(row) {
  return extractPercent(row?.resultadoGeneral ?? row?.nota ?? row?.score ?? row?.puntaje ?? row?.calificacion);
}

async function getAdvisorScoreRanking(args = {}) {
  const limit = clampLimit(args.limit, 5);
  const order = normalizeText(args.order || args.direction || "asc") === "desc" ? "desc" : "asc";
  const rows = await readCollection("evaluations");
  const deletedIds = await getDeletedEvaluationIds();
  const groups = new Map();
  rows.forEach(row => {
    if (isDeletedEvaluation(row, deletedIds)) return;
    const advisor = String(row?.asesorNombre || row?.asesor || row?.advisorName || row?.agentName || "").trim();
    const score = getEvaluationScore(row);
    if (!advisor || score === null) return;
    if (!groups.has(advisor)) {
      groups.set(advisor, {
        asesor: advisor,
        totalEvaluaciones: 0,
        sumaNotas: 0,
        notaPromedio: 0,
        notaMinima: score,
        notaMaxima: score,
        ultimaEvaluacion: "",
        ultimaNota: score
      });
    }
    const item = groups.get(advisor);
    item.totalEvaluaciones += 1;
    item.sumaNotas += score;
    item.notaMinima = Math.min(item.notaMinima, score);
    item.notaMaxima = Math.max(item.notaMaxima, score);
    const date = String(row?.fechaEvaluacion || row?.createdAt || row?.updatedAt || "");
    if (!item.ultimaEvaluacion || date > item.ultimaEvaluacion) {
      item.ultimaEvaluacion = date;
      item.ultimaNota = score;
    }
  });
  const ranking = [...groups.values()]
    .map(item => ({
      ...item,
      notaPromedio: Number((item.sumaNotas / item.totalEvaluaciones).toFixed(1)),
      tieneEvaluacionesValidas: item.totalEvaluaciones > 0
    }))
    .sort((a, b) => {
      const scoreSort = order === "desc" ? b.notaPromedio - a.notaPromedio : a.notaPromedio - b.notaPromedio;
      return scoreSort || b.totalEvaluaciones - a.totalEvaluaciones || a.asesor.localeCompare(b.asesor, "es");
    })
    .slice(0, limit);
  return {
    ok: true,
    metric: "notaPromedio",
    order,
    totalEvaluaciones: rows.length,
    evaluacionesExcluidasEliminadas: rows.filter(row => isDeletedEvaluation(row, deletedIds)).length,
    asesoresConNota: groups.size,
    scoreInterpretation: "La nota 0.0 es una nota valida cuando totalEvaluaciones es mayor que 0; no significa falta de datos.",
    ranking
  };
}

async function getAdvisorSeniorityRanking(args = {}) {
  const limit = clampLimit(args.limit, 5);
  const orderText = normalizeText(args.order || args.direction || "oldest");
  const newestFirst = /(new|nuevo|reciente|menor|asc)/.test(orderText);
  const includeInactive = args.includeInactive === true || normalizeText(args.includeInactive) === "true";
  const rows = await readCollection("staffing");
  const activeRows = includeInactive ? rows : rows.filter(isActiveStaffing);
  const ranking = activeRows
    .map(row => {
      const entryDate = parseDateValue(row?.fechaIngreso || row?.fecha_ingreso || row?.ingreso || row?.startDate || row?.createdAt);
      const storedMonths = extractPercent(row?.antiguedad || row?.antigüedad || row?.tenureMonths);
      const calculatedMonths = monthsBetween(entryDate);
      const seniorityMonths = storedMonths !== null ? storedMonths : calculatedMonths;
      return {
        asesor: String(row?.asesor || row?.assessorName || row?.advisorName || row?.nombre || row?.name || "").trim(),
        usuario: String(row?.usuarioAsignado || row?.usuario || "").trim(),
        supervisor: String(row?.supervisor || "").trim(),
        coordinador: String(row?.coordinador || "").trim(),
        tipoGestion: String(row?.tipoGestionRuc || row?.campaign || row?.campana || "").trim(),
        fechaIngreso: formatDateOnly(row?.fechaIngreso || row?.fecha_ingreso || row?.ingreso || row?.startDate || row?.createdAt),
        antiguedadMeses: seniorityMonths === null ? null : Number(seniorityMonths),
        antiguedadTexto: seniorityMonths === null ? "Sin dato" : `${Number(seniorityMonths)} mes(es)`,
        estado: String(row?.estado || "activo").trim() || "activo"
      };
    })
    .filter(item => item.asesor)
    .sort((a, b) => {
      const aMonths = a.antiguedadMeses ?? -1;
      const bMonths = b.antiguedadMeses ?? -1;
      const senioritySort = newestFirst ? aMonths - bMonths : bMonths - aMonths;
      if (senioritySort) return senioritySort;
      const aDate = parseDateValue(a.fechaIngreso)?.getTime() || 0;
      const bDate = parseDateValue(b.fechaIngreso)?.getTime() || 0;
      const dateSort = newestFirst ? bDate - aDate : aDate - bDate;
      return dateSort || a.asesor.localeCompare(b.asesor, "es");
    })
    .slice(0, limit);
  return {
    ok: true,
    metric: "antiguedadMeses",
    order: newestFirst ? "newest" : "oldest",
    totalDotacion: rows.length,
    dotacionActiva: rows.filter(isActiveStaffing).length,
    includeInactive,
    ranking
  };
}

function resolveCollections(collection) {
  const raw = normalizeText(collection);
  if (!raw || raw === "all" || raw === "todas" || raw === "todos") return Object.keys(COLLECTIONS);
  const direct = COLLECTIONS[raw] ? raw : Object.keys(COLLECTIONS).find(key => normalizeText(key) === raw);
  if (direct) return [direct];
  const found = Object.entries(COLLECTIONS)
    .filter(([key, meta]) => key.includes(raw) || meta.aliases.some(alias => normalizeText(alias).includes(raw) || raw.includes(normalizeText(alias))))
    .map(([key]) => key);
  return found.length ? found : Object.keys(COLLECTIONS);
}

function getByPath(record, path) {
  const parts = String(path || "").split(".").map(item => item.trim()).filter(Boolean);
  let current = record;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function recordMatchesQuery(record, query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return true;
  const text = normalizeText(JSON.stringify(compactValue(record)));
  return normalizedQuery.split(/\s+/).filter(Boolean).every(term => text.includes(term));
}

async function readCollection(collectionKey) {
  const meta = COLLECTIONS[collectionKey];
  if (!meta) return [];
  const data = await readSharedJson(meta.key, []);
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return Object.values(data);
  return [];
}

export const aiToolDefinitions = [
  {
    type: "function",
    function: {
      name: "get_database_summary",
      description: "Obtiene totales y muestras compactas de colecciones reales de Firebase.",
      parameters: {
        type: "object",
        properties: {
          collections: {
            type: "array",
            items: { type: "string" },
            description: "Colecciones a revisar: evaluations, feedback, incidents, no_tipification, sales_validations, calibration_sessions, calibration_results, staffing, users, communications. Usa vacio para todas."
          },
          sampleLimit: {
            ...LIMIT_PARAMETER_SCHEMA,
            description: "Cantidad maxima de ejemplos por coleccion. Puede llegar como numero o texto; el backend lo normaliza."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_database_records",
      description: "Busca registros reales en Firebase por texto libre y coleccion.",
      parameters: {
        type: "object",
        properties: {
          collection: { type: "string", description: "Coleccion o alias donde buscar. Usa all para todas." },
          query: { type: "string", description: "Texto a buscar, por ejemplo nombre de asesor, RUC, estado, campana o tipo." },
          limit: LIMIT_PARAMETER_SCHEMA
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "aggregate_database_counts",
      description: "Agrupa una coleccion real de Firebase por un campo y devuelve conteos.",
      parameters: {
        type: "object",
        required: ["collection", "field"],
        properties: {
          collection: { type: "string", description: "Coleccion a agrupar." },
          field: { type: "string", description: "Campo a agrupar. Puede ser anidado con punto, por ejemplo user.role." },
          limit: LIMIT_PARAMETER_SCHEMA
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_lowest_advisors",
      description: "Calcula los asesores con menor nota promedio real usando evaluaciones de calidad en Firebase. Util para preguntas como 'asesores mas bajos', 'peores notas' o 'ranking inferior'.",
      parameters: {
        type: "object",
        properties: {
          limit: LIMIT_PARAMETER_SCHEMA
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_advisor_score_ranking",
      description: "Calcula ranking de asesores por nota promedio real usando evaluaciones de calidad en Firebase. Usa order asc para mas bajos y desc para mejores.",
      parameters: {
        type: "object",
        properties: {
          limit: LIMIT_PARAMETER_SCHEMA,
          order: { type: "string", enum: ["asc", "desc"], description: "asc para mas bajos, desc para mejores." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_advisor_seniority_ranking",
      description: "Calcula el ranking de asesores por antiguedad usando la dotacion real en Firebase. Util para preguntas como 'asesores mas antiguos', 'mas nuevos' o 'mayor antiguedad'.",
      parameters: {
        type: "object",
        properties: {
          limit: LIMIT_PARAMETER_SCHEMA,
          order: { type: "string", enum: ["oldest", "newest"], description: "oldest para mas antiguos, newest para mas nuevos." },
          includeInactive: { type: "boolean", description: "true para incluir usuarios cesados o inactivos." }
        }
      }
    }
  }
];

export async function executeAiTool(name, args = {}) {
  if (name === "get_database_summary") {
    const requested = Array.isArray(args.collections) && args.collections.length
      ? [...new Set(args.collections.flatMap(resolveCollections))]
      : Object.keys(COLLECTIONS);
    const sampleLimit = Math.min(1, clampLimit(args.sampleLimit, 1));
    const collections = {};
    const totals = {};
    for (const key of requested) {
      const rows = await readCollection(key);
      totals[key] = rows.length;
      collections[key] = {
        label: COLLECTIONS[key]?.label || key,
        total: rows.length,
        sample: rows.slice(0, sampleLimit).map(row => compactValue(row))
      };
    }
    return { ok: true, totals, collections };
  }

  if (name === "search_database_records") {
    const collections = resolveCollections(args.collection);
    const limit = clampLimit(args.limit, 15);
    const results = [];
    for (const key of collections) {
      const rows = await readCollection(key);
      rows.forEach((row, index) => {
        if (recordMatchesQuery(row, args.query)) {
          results.push({
            collection: key,
            collectionLabel: COLLECTIONS[key]?.label || key,
            index,
            record: compactValue(row)
          });
        }
      });
      if (results.length >= limit) break;
    }
    return { ok: true, query: args.query || "", totalReturned: Math.min(results.length, limit), results: results.slice(0, limit) };
  }

  if (name === "aggregate_database_counts") {
    const key = resolveCollections(args.collection)[0];
    const rows = await readCollection(key);
    const counts = new Map();
    rows.forEach(row => {
      const raw = getByPath(row, args.field);
      const label = String(raw === undefined || raw === null || raw === "" ? "Sin dato" : raw);
      counts.set(label, (counts.get(label) || 0) + 1);
    });
    const limit = clampLimit(args.limit, 20);
    const groups = [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "es"))
      .slice(0, limit);
    return { ok: true, collection: key, field: args.field, totalRows: rows.length, groups };
  }

  if (name === "get_lowest_advisors") {
    return getAdvisorScoreRanking({ ...args, order: "asc" });
  }

  if (name === "get_advisor_score_ranking") {
    return getAdvisorScoreRanking(args);
  }

  if (name === "get_advisor_seniority_ranking") {
    return getAdvisorSeniorityRanking(args);
  }

  return { ok: false, error: `Herramienta IA no disponible: ${name}` };
}

export function truncateToolResult(value) {
  const text = JSON.stringify(value || {});
  if (text.length <= MAX_RECORD_CHARS) return text;
  return `${text.slice(0, MAX_RECORD_CHARS)}...[resultado truncado]`;
}
