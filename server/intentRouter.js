export const IntentType = Object.freeze({
  data: "data",
  hybrid: "hybrid",
  ai: "ai"
});

const DATA_KEYWORDS = [
  "ranking",
  "top",
  "bottom",
  "ultimo",
  "ultimos",
  "ultima",
  "ultimas",
  "mejor",
  "mejores",
  "peor",
  "peores",
  "bajo",
  "bajos",
  "baja",
  "bajas",
  "menor",
  "menores",
  "venta",
  "ventas",
  "spd",
  "sph",
  "promedio",
  "cantidad",
  "cuantos",
  "cuantas",
  "porcentaje",
  "desempeno",
  "desempeño",
  "asesor",
  "asesores",
  "ejecutivo",
  "ejecutivos",
  "agente",
  "agentes",
  "indicador",
  "indicadores",
  "campana",
  "campaña",
  "campanas",
  "campañas",
  "supervisor",
  "supervisores",
  "feedback",
  "feedbacks",
  "evaluacion",
  "evaluaciones",
  "incidencia",
  "incidencias",
  "calibracion",
  "calibraciones"
];

const HYBRID_KEYWORDS = [
  "analiza",
  "analisis",
  "análisis",
  "conclusion",
  "conclusiones",
  "recomendacion",
  "recomendaciones",
  "oportunidad",
  "oportunidades",
  "fortaleza",
  "fortalezas",
  "debilidad",
  "debilidades",
  "plan de accion",
  "plan de acción",
  "accion",
  "acción",
  "acciones",
  "tendencia",
  "tendencias",
  "predice",
  "prediccion",
  "predicción",
  "riesgo",
  "riesgos",
  "coaching",
  "interpreta",
  "interpretacion",
  "interpretación",
  "prioridad",
  "prioridades"
];

const AI_KEYWORDS = [
  "redacta",
  "correo",
  "discurso",
  "explica",
  "copc",
  "curso",
  "taller",
  "resume este texto",
  "resumen de este texto"
];

function normalizeIntentText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function includesAny(text, keywords) {
  return keywords.some(keyword => text.includes(normalizeIntentText(keyword)));
}

export class IntentRouter {
  detectIntent(question = "") {
    const text = normalizeIntentText(question);
    if (!text) return IntentType.hybrid;

    const hasHybridIntent = includesAny(text, HYBRID_KEYWORDS);
    const hasDataIntent = includesAny(text, DATA_KEYWORDS);
    const hasAiIntent = includesAny(text, AI_KEYWORDS);

    if (hasHybridIntent && hasDataIntent) return IntentType.hybrid;
    if (hasDataIntent) return IntentType.data;
    if (hasHybridIntent) return IntentType.hybrid;
    if (hasAiIntent) return IntentType.ai;
    return IntentType.ai;
  }
}
