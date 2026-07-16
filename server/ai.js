import { config } from "./config.js";
import { aiToolDefinitions, executeAiTool, truncateToolResult } from "./aiDataTools.js";

const MAX_CONTEXT_CHARS = 18000;
const MAX_MEMORY_MESSAGES = 12;

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
      content: String(item.content || "").slice(0, 2400)
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
      max_tokens: 1000,
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
  const visibleText = String(context?.visibleScreen?.text || "").trim();
  if (visibleText) {
    const preview = visibleText.split("\n").filter(Boolean).slice(0, 12).join("\n");
    return [
      "Lectura rapida de la pantalla visible:",
      preview,
      question ? `Consulta recibida: ${question}` : "",
      "Para conclusiones IA completas, valida GROQ_API_KEY en Railway."
    ].filter(Boolean).join("\n");
  }
  const summary = context?.summary || {};
  const lines = [
    "No tengo una llave de Groq configurada todavia, pero puedo darte una lectura rapida con los datos disponibles:",
    `- Evaluaciones visibles: ${summary.evaluations?.total ?? 0}. Promedio: ${summary.evaluations?.averageScore ?? "sin dato"}%.`,
    `- Feedbacks: ${summary.feedback?.total ?? 0}. Pendientes: ${summary.feedback?.pending ?? 0}. Cerrados: ${summary.feedback?.closed ?? 0}.`,
    `- Incidencias operativas: ${summary.operationalIncidents?.total ?? 0}.`,
    `- Validaciones de venta: ${summary.salesValidations?.total ?? 0}. Observadas/sin audio: ${summary.salesValidations?.attentionRequired ?? 0}.`
  ];
  if (question) lines.push(`Consulta recibida: ${question}`);
  lines.push("Para activar conclusiones IA completas, configura GROQ_API_KEY en Railway.");
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
        "La fuente primaria inicial es context.visibleScreen.text: representa lo visible en la pantalla actual sin el menu lateral.",
        "Si necesitas validar cifras, buscar registros, agrupar datos o responder sobre informacion que no esta visible, usa las herramientas disponibles para consultar Firebase.",
        "Si el resumen global contradice la pantalla visible o los resultados de herramientas, obedece primero los resultados de herramientas y luego la pantalla visible.",
        "No inventes cifras ni menciones modulos que no aparezcan en la pantalla visible o en los datos consultados.",
        "Usa formato Markdown con **negritas** en hallazgos, riesgos y acciones clave."
      ].join(" ")
    },
    {
      role: "user",
      content: `Contexto de pantalla actual. Prioriza visibleScreen.text porque es la lectura de la pantalla actual sin menu lateral:\n${contextText}`
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

