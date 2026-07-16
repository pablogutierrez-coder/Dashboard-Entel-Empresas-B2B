import { config } from "./config.js";

const MAX_CONTEXT_CHARS = 18000;

function truncateText(value, maxLength = MAX_CONTEXT_CHARS) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[contexto truncado para seguridad]`;
}

function extractGroqText(payload) {
  return String(payload?.choices?.[0]?.message?.content || "").trim();
}

function localFallbackInsights(context, question) {
  const summary = context?.summary || {};
  const lines = [
    "No tengo una llave de Groq configurada todavía, pero puedo darte una lectura rápida con los datos disponibles:",
    `- Evaluaciones visibles: ${summary.evaluations?.total ?? 0}. Promedio: ${summary.evaluations?.averageScore ?? "sin dato"}%.`,
    `- Feedbacks: ${summary.feedback?.total ?? 0}. Pendientes: ${summary.feedback?.pending ?? 0}. Cerrados: ${summary.feedback?.closed ?? 0}.`,
    `- Incidencias operativas: ${summary.operationalIncidents?.total ?? 0}.`,
    `- Validaciones de venta: ${summary.salesValidations?.total ?? 0}. Observadas/sin audio: ${summary.salesValidations?.attentionRequired ?? 0}.`
  ];
  if (question) lines.push(`Consulta recibida: ${question}`);
  lines.push("Para activar conclusiones IA completas, configura GROQ_API_KEY en Railway.");
  return lines.join("\n");
}

export async function generateDashboardInsights({ question = "", context = {} }) {
  const safeQuestion = String(question || "").trim().slice(0, 1200);
  if (!config.groqApiKey) {
    return {
      ok: true,
      mode: "local_fallback",
      answer: localFallbackInsights(context, safeQuestion)
    };
  }

  const contextText = truncateText(context);
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.groqApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.groqModel,
      messages: [
        {
          role: "system",
          content: "Eres Tigre IA, un analista senior de calidad B2B. Responde en español claro, ejecutivo y accionable. Usa solo los datos entregados. Si faltan datos, dilo. Prioriza conclusiones, riesgos, alertas y siguientes acciones. No inventes cifras."
        },
        {
          role: "user",
          content: `Pregunta del usuario: ${safeQuestion || "Genera conclusiones ejecutivas del dashboard actual."}\n\nContexto JSON del dashboard:\n${contextText}`
        }
      ],
      temperature: 0.2,
      max_tokens: 900
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `Groq HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return {
    ok: true,
    mode: "groq",
    model: config.groqModel,
    answer: extractGroqText(payload) || "No pude generar una conclusión con la respuesta recibida."
  };
}
