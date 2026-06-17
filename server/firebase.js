import { config, requireConfig } from "./config.js";

function firebaseUrl(path) {
  requireConfig("FIREBASE_URL", config.firebaseUrl);
  const cleanPath = String(path || "").replace(/^\/+/, "");
  const separator = cleanPath.includes("?") ? "&" : "?";
  const auth = config.firebaseSecret ? `${separator}auth=${encodeURIComponent(config.firebaseSecret)}` : "";
  return `${config.firebaseUrl}${cleanPath}${auth}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`Firebase HTTP ${response.status}: ${text || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function readSharedRecord(key) {
  const cleanKey = String(key || "").trim();
  if (!cleanKey) return null;
  const data = await fetchJson(firebaseUrl(`shared/${encodeURIComponent(cleanKey)}.json`));
  if (data && data.value !== undefined && data.value !== null) {
    return { value: String(data.value || ""), timestamp: data.timestamp || "" };
  }
  if (data !== null && data !== undefined) {
    return { value: JSON.stringify(data), timestamp: "" };
  }
  return null;
}

export async function readSharedJson(key, fallbackValue = null) {
  const record = await readSharedRecord(key);
  if (!record || !record.value) return fallbackValue;
  try {
    return JSON.parse(record.value);
  } catch {
    return record.value;
  }
}

export async function writeSharedRecord(key, value) {
  const cleanKey = String(key || "").trim();
  if (!cleanKey) throw new Error("No se puede guardar una clave Firebase vacia.");
  const payload = {
    value: typeof value === "string" ? value : JSON.stringify(value),
    timestamp: new Date().toISOString()
  };
  await fetchJson(firebaseUrl(`shared/${encodeURIComponent(cleanKey)}.json`), {
    method: "PUT",
    body: JSON.stringify(payload)
  });
  return payload;
}

export async function deleteSharedRecord(key) {
  const cleanKey = String(key || "").trim();
  if (!cleanKey) return false;
  await fetchJson(firebaseUrl(`shared/${encodeURIComponent(cleanKey)}.json`), { method: "DELETE" });
  return true;
}

export async function listSharedKeys(prefix = "") {
  const data = await fetchJson(firebaseUrl("shared.json?shallow=true")) || {};
  return Object.keys(data).filter(key => key.startsWith(String(prefix || "")));
}

export function normalizeId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const numeric = Number(text);
  return Number.isNaN(numeric) ? text : String(numeric);
}

export function getEvaluationRecordKey(id) {
  return `evaluation_record_${normalizeId(id)}`;
}
