import { config } from "./config.js";
import { aiToolDefinitions, executeAiTool, truncateToolResult } from "./aiDataTools.js";

const MAX_CONTEXT_CHARS = 2500;
const MAX_MEMORY_MESSAGES = 8;

function truncateText(value, maxLength = MAX_CONTEXT_CHARS) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[contexto truncado para seguridad]`;
}

function extractGroqText(payload) {
  return String(payload?.choices?.[0]?.message?.content || "").trim();
}

function sanitizeConversationMessages(messages = []) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(item => item && ["user", "assistant"].includes(item.role))
    .slice(-MAX_MEMORY_MESSAGES)
    .map(item => ({
      role: item.role,
      content: String(item.content || "").slice(0, 1200)
    }))
    .filter(item => item.content.trim());
}

async function callGroq(messages, options = {}) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.groqApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.groqModel,
      messages,
      temperature: 0.2,
      max_tokens: 850,
      ...(options.tools ? { tools: options.tools, tool_choice: "auto" } : {})
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `Groq HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function localFallbackInsights(context, question) {
  const lines = [
    "La IA de Groq no esta disponible en este momento.",
    "El modo con base de datos requiere GROQ_API_KEY activa porque las consultas se ejecutan mediante herramientas del agente."
  ];
  if (question) lines.push(`Consulta recibida: ${question}`);
  return lines.join("\n");
}

export async function generateDashboardInsights({ question = "", context = {}, messages = [] }) {
  const safeQuestion = String(question || "").trim().slice(0, 1200);
  const memoryMessages = sanitizeConversationMessages(messages);
  if (!config.groqApiKey) {
    return {
      ok: true,
      mode: "local_fallback",
      answer: localFallbackInsights(context, safeQuestion),
      memoryUsed: memoryMessages.length,
      toolsUsed: []
    };
  }

  const contextText = truncateText(context);
  const baseMessages = [
    {
      role: "system",
      content: [
        "Eres Tigre IA, un agente analitico senior de calidad B2B.",
        "Responde en espanol claro, ejecutivo y accionable.",
        "Mantienes memoria conversacional: usa el historial de mensajes para conservar el hilo, referencias previas y preguntas de seguimiento.",
        "No leas ni resumas la pantalla. No uses contenido visual como fuente de datos.",
        "Tu unica fuente factual son las herramientas conectadas a Firebase y la memoria conversacional.",
        "Para cualquier cifra, ranking, alerta, tendencia, busqueda o conclusion de negocio, primero consulta Firebase con herramientas.",
        "Para preguntas sobre asesores con notas mas bajas, peores resultados o ranking inferior, usa get_lowest_advisors antes de responder.",
        "Si una herramienta devuelve nota 0.0 con evaluaciones asociadas, interpretalo como una nota valida de calidad, no como ausencia de datos.",
        "Si no usas herramientas, solo puedes responder preguntas conceptuales o pedir precision.",
        "Cuando uses herramientas, revisa primero campos totals, totalRows y totalReturned antes de interpretar muestras. No concluyas que una coleccion no existe solo porque sus muestras fueron resumidas o truncadas.",
        "No inventes cifras ni menciones datos que no esten en los resultados consultados.",
        "Usa formato Markdown con **negritas** en hallazgos, riesgos y acciones clave."
      ].join(" ")
    },
    {
      role: "user",
      content: `Contexto minimo de sesion. No contiene datos de pantalla; usa herramientas Firebase para datos reales:\n${contextText}`
    },
    ...memoryMessages,
    {
      role: "user",
      content: safeQuestion || "Genera conclusiones ejecutivas de la pantalla actual."
    }
  ];

  const firstPayload = await callGroq(baseMessages, { tools: aiToolDefinitions });
  const firstMessage = firstPayload?.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(firstMessage.tool_calls) ? firstMessage.tool_calls.slice(0, 5) : [];
  const toolsUsed = [];

  if (toolCalls.length) {
    const toolMessages = [firstMessage];
    for (const call of toolCalls) {
      const name = call?.function?.name || "";
      let args = {};
      try {
        args = JSON.parse(call?.function?.arguments || "{}");
      } catch {
        args = {};
      }
      const result = await executeAiTool(name, args);
      toolsUsed.push({ name, args });
      toolMessages.push({
        role: "tool",
        tool_call_id: call.id,
        name,
        content: truncateToolResult(result)
      });
    }
    const finalPayload = await callGroq([
      ...baseMessages,
      ...toolMessages,
      {
        role: "user",
        content: "Con los resultados de herramientas anteriores, responde la pregunta de forma ejecutiva, accionable y sin inventar datos."
      }
    ]);
    return {
      ok: true,
      mode: "groq",
      model: config.groqModel,
      answer: extractGroqText(finalPayload) || "No pude generar una conclusion con la respuesta recibida.",
      memoryUsed: memoryMessages.length,
      toolsUsed
    };
  }

  return {
    ok: true,
    mode: "groq",
    model: config.groqModel,
    answer: extractGroqText(firstPayload) || "No pude generar una conclusion con la respuesta recibida.",
    memoryUsed: memoryMessages.length,
    toolsUsed
  };
}

