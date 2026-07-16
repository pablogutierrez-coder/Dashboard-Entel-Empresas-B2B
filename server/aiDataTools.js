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
          sampleLimit: { type: "number", description: "Cantidad maxima de ejemplos por coleccion." }
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
          limit: { type: "number", description: "Maximo de registros a devolver." }
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
          limit: { type: "number", description: "Maximo de grupos a devolver." }
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

  return { ok: false, error: `Herramienta IA no disponible: ${name}` };
}

export function truncateToolResult(value) {
  const text = JSON.stringify(value || {});
  if (text.length <= MAX_RECORD_CHARS) return text;
  return `${text.slice(0, MAX_RECORD_CHARS)}...[resultado truncado]`;
}
