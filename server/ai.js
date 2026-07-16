import { config } from "./config.js";
import { aiToolDefinitions, executeAiTool, truncateToolResult } from "./aiDataTools.js";
import { IntentRouter, IntentType } from "./intentRouter.js";

const MAX_CONTEXT_CHARS = 1200;
const MAX_MEMORY_MESSAGES = 5;
const intentRouter = new IntentRouter();

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
      max_tokens: 520,
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

function normalizeAiText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function shouldUseLowestAdvisorsFallback(question) {
  const text = normalizeAiText(question);
  const asksForPeople = /(asesor|asesores|ejecutivo|ejecutivos|agente|agentes|personal)/.test(text);
  const asksForLowRank = /(bajo|bajos|baja|bajas|menor|menores|peor|peores|inferior|critico|criticos|ranking|top|bottom|nota|notas|promedio)/.test(text);
  return asksForPeople && asksForLowRank;
}

function shouldUseAdvisorRanking(question) {
  const text = normalizeAiText(question);
  return /(asesor|asesores|ejecutivo|ejecutivos|agente|agentes|personal)/.test(text)
    && /(ranking|top|bottom|mejor|mejores|peor|peores|bajo|bajos|menor|menores|nota|notas|promedio|desempeno|desempeno)/.test(text);
}

function shouldUseAdvisorSeniority(question) {
  const text = normalizeAiText(question);
  return /(asesor|asesores|ejecutivo|ejecutivos|agente|agentes|personal|dotacion)/.test(text)
    && /(antiguo|antiguos|antigua|antiguas|antiguedad|veterano|veteranos|tiempo|ingreso|nuevo|nuevos|nueva|nuevas|reciente|recientes)/.test(text);
}

function rankingOrderFromQuestion(question) {
  const text = normalizeAiText(question);
  return /(mejor|mejores|alto|altos|mayor|mayores|superior)/.test(text) ? "desc" : "asc";
}

function seniorityOrderFromQuestion(question) {
  const text = normalizeAiText(question);
  return /(nuevo|nuevos|nueva|nuevas|reciente|recientes|menor antiguedad|menos antiguo)/.test(text) ? "newest" : "oldest";
}

function extractRequestedLimit(question, fallback = 5) {
  const match = String(question || "").match(/\b(\d{1,2})\b/);
  if (!match) return fallback;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(20, parsed);
}

function formatAdvisorRankingAnswer(result, order = "asc") {
  const ranking = Array.isArray(result?.ranking) ? result.ranking : [];
  if (!ranking.length) {
    return [
      "**No encontre asesores con notas disponibles en Firebase.**",
      "",
      "La consulta se hizo directamente a la base de datos, pero no hubo registros con nota calculable."
    ].join("\n");
  }
  const isBest = order === "desc";
  const lines = [
    `**Top ${ranking.length} asesores con nota ${isBest ? "mas alta" : "mas baja"}**`,
    "",
    `Base consultada: **${result.totalEvaluaciones || 0} evaluaciones** y **${result.asesoresConNota || 0} asesores con nota**.`,
    ""
  ];
  ranking.forEach((item, index) => {
    lines.push(`${index + 1}. **${item.asesor}** - **${Number(item.notaPromedio || 0).toFixed(1)}%** promedio (${item.totalEvaluaciones} evaluacion(es)).`);
  });
  lines.push("");
  lines.push(isBest
    ? "**Lectura rapida:** estos asesores concentran los mejores promedios de calidad registrados."
    : "**Lectura rapida:** estos asesores requieren revision prioritaria porque concentran los promedios mas bajos de calidad registrados.");
  return lines.join("\n");
}

function formatAdvisorSeniorityAnswer(result, order = "oldest") {
  const ranking = Array.isArray(result?.ranking) ? result.ranking : [];
  if (!ranking.length) {
    return [
      "**No encontre asesores activos con antiguedad disponible en Firebase.**",
      "",
      "La consulta se hizo directamente a la coleccion de dotacion, pero no hubo registros para listar."
    ].join("\n");
  }
  const isNewest = order === "newest";
  const lines = [
    `**Top ${ranking.length} asesores ${isNewest ? "mas nuevos" : "mas antiguos"}**`,
    "",
    `Base consultada: **${result.dotacionActiva || 0} asesores activos** de **${result.totalDotacion || 0} registros de dotacion**.`,
    ""
  ];
  ranking.forEach((item, index) => {
    const details = [
      item.antiguedadTexto || "Sin antiguedad",
      item.fechaIngreso ? `ingreso ${item.fechaIngreso}` : "",
      item.supervisor ? `supervisor: ${item.supervisor}` : ""
    ].filter(Boolean).join(" | ");
    lines.push(`${index + 1}. **${item.asesor}** - ${details}.`);
  });
  lines.push("");
  lines.push(isNewest
    ? "**Lectura rapida:** estos asesores son los de menor antiguedad activa en dotacion."
    : "**Lectura rapida:** estos asesores concentran la mayor antiguedad activa en dotacion.");
  return lines.join("\n");
}

function inferCollectionsFromQuestion(question) {
  const text = normalizeAiText(question);
  const collections = [];
  if (shouldUseAdvisorSeniority(question)) collections.push("staffing");
  if (/(evaluacion|evaluaciones|calidad|asesor|asesores|supervisor|supervisores|promedio|nota|notas)/.test(text)) collections.push("evaluations");
  if (/(feedback|feedbacks|retroalimentacion|retroalimentaciones|seguimiento)/.test(text)) collections.push("feedback");
  if (/(incidencia|incidencias|no conectado|no tipificacion|alerta|alertas)/.test(text)) collections.push("incidents", "no_tipification");
  if (/(venta|ventas|validacion|validaciones|spd|sph)/.test(text)) collections.push("sales_validations");
  if (/(calibracion|calibraciones|referente|afinidad)/.test(text)) collections.push("calibration_sessions", "calibration_results");
  if (/(usuario|usuarios|dotacion|personal)/.test(text)) collections.push("users", "staffing");
  return [...new Set(collections.length ? collections : ["evaluations", "feedback", "incidents", "sales_validations"])];
}

function formatDatabaseSummaryAnswer(summary, question) {
  const totals = summary?.totals || {};
  const labels = {
    evaluations: "Evaluaciones",
    feedback: "Feedbacks",
    incidents: "Incidencias operativas",
    no_tipification: "No tipificacion",
    sales_validations: "Validaciones de ventas",
    calibration_sessions: "Calibraciones",
    calibration_results: "Resultados de calibracion",
    staffing: "Dotacion",
    users: "Usuarios",
    communications: "Comunicados"
  };
  const lines = ["**Consulta respondida desde Firebase**", ""];
  Object.entries(totals).forEach(([key, total]) => {
    lines.push(`- **${labels[key] || key}:** ${total}`);
  });
  if (Object.keys(totals).length === 0) lines.push("No encontre registros para la consulta solicitada.");
  if (question) {
    lines.push("");
    lines.push(`Consulta: ${question}`);
  }
  return lines.join("\n");
}

async function localDatabaseAnswer(question) {
  if (shouldUseAdvisorSeniority(question)) {
    const limit = extractRequestedLimit(question, 5);
    const order = seniorityOrderFromQuestion(question);
    const result = await executeAiTool("get_advisor_seniority_ranking", { limit, order });
    return {
      ok: true,
      mode: "database_fallback",
      source: "firebase",
      intent: IntentType.data,
      answer: formatAdvisorSeniorityAnswer(result, order),
      memoryUsed: 0,
      toolsUsed: [{ name: "get_advisor_seniority_ranking", args: { limit, order } }]
    };
  }

  if (shouldUseAdvisorRanking(question) || shouldUseLowestAdvisorsFallback(question)) {
    const limit = extractRequestedLimit(question, 5);
    const order = rankingOrderFromQuestion(question);
    const result = await executeAiTool("get_advisor_score_ranking", { limit, order });
    return {
      ok: true,
      mode: "database_fallback",
      source: "firebase",
      intent: IntentType.data,
      answer: formatAdvisorRankingAnswer(result, order),
      memoryUsed: 0,
      toolsUsed: [{ name: "get_advisor_score_ranking", args: { limit, order } }]
    };
  }
  const collections = inferCollectionsFromQuestion(question);
  const summary = await executeAiTool("get_database_summary", { collections, sampleLimit: 0 });
  return {
    ok: true,
    mode: "database_fallback",
    source: "firebase",
    intent: IntentType.data,
    answer: formatDatabaseSummaryAnswer(summary, question),
    memoryUsed: 0,
    toolsUsed: [{ name: "get_database_summary", args: { collections, sampleLimit: 0 } }]
  };
}

async function buildHybridDataContext(question) {
  const collections = inferCollectionsFromQuestion(question);
  const summary = await executeAiTool("get_database_summary", { collections, sampleLimit: 1 });
  let ranking = null;
  if (/(asesor|asesores|ejecutivo|ejecutivos|agente|agentes|desempeno|desempeno|nota|notas|promedio|ranking)/.test(normalizeAiText(question))) {
    ranking = await executeAiTool("get_advisor_score_ranking", { limit: 8, order: "asc" });
  }
  return { summary, ranking };
}

function compactHybridPromptData(value) {
  return truncateText(value, 4200);
}

async function groqTextAnswer(messages, mode, source, intent, memoryMessages, toolsUsed = []) {
  const payload = await callGroq(messages);
  return {
    ok: true,
    mode,
    source,
    intent,
    model: config.groqModel,
    answer: extractGroqText(payload) || "No pude generar una respuesta con la informacion recibida.",
    memoryUsed: memoryMessages.length,
    toolsUsed
  };
}

async function generateHybridAnswer({ safeQuestion, memoryMessages, context }) {
  const dataContext = await buildHybridDataContext(safeQuestion);
  const messages = [
    {
      role: "system",
      content: [
        "Eres Tigre IA, consultor senior de calidad B2B.",
        "Recibiras datos compactos ya consultados desde Firebase.",
        "Genera conclusiones, riesgos, oportunidades y acciones sin inventar cifras.",
        "Usa Markdown con **negritas** y una estructura ejecutiva."
      ].join(" ")
    },
    {
      role: "user",
      content: `Datos Firebase para analizar:\n${compactHybridPromptData(dataContext)}`
    },
    ...memoryMessages,
    {
      role: "user",
      content: safeQuestion || "Genera conclusiones ejecutivas con estos datos."
    }
  ];
  try {
    return await groqTextAnswer(messages, "hybrid", "hybrid", IntentType.hybrid, memoryMessages, [
      { name: "get_database_summary", args: { collections: inferCollectionsFromQuestion(safeQuestion), sampleLimit: 1 } },
      ...(dataContext.ranking ? [{ name: "get_advisor_score_ranking", args: { limit: 8, order: "asc" } }] : [])
    ]);
  } catch (error) {
    if (isGroqLimitError(error)) {
      return {
        ok: true,
        mode: "hybrid_rate_limited",
        source: "firebase",
        intent: IntentType.hybrid,
        answer: [
          "**Groq llego al limite de tokens, pero Firebase respondio correctamente.**",
          "",
          formatDatabaseSummaryAnswer(dataContext.summary, safeQuestion)
        ].join("\n"),
        memoryUsed: memoryMessages.length,
        toolsUsed: [{ name: "get_database_summary", args: { collections: inferCollectionsFromQuestion(safeQuestion), sampleLimit: 1 } }]
      };
    }
    throw error;
  }
}

async function generateAiOnlyAnswer({ safeQuestion, memoryMessages }) {
  const messages = [
    {
      role: "system",
      content: "Eres Tigre IA. Responde en espanol claro, util y ejecutivo. Esta consulta no requiere datos de Firebase."
    },
    ...memoryMessages,
    {
      role: "user",
      content: safeQuestion
    }
  ];
  try {
    return await groqTextAnswer(messages, "groq", "ai", IntentType.ai, memoryMessages);
  } catch (error) {
    if (isGroqLimitError(error)) {
      return {
        ok: true,
        mode: "groq_rate_limited",
        source: "ai",
        intent: IntentType.ai,
        answer: "**Tigre IA llego al limite temporal de Groq.** Esta consulta requiere IA generativa; intenta nuevamente cuando se libere cuota.",
        memoryUsed: memoryMessages.length,
        toolsUsed: []
      };
    }
    throw error;
  }
}

async function legacyToolAgentAnswer({ safeQuestion, context, memoryMessages }) {
  if (!config.groqApiKey) {
    return {
      ok: true,
      mode: "local_fallback",
      source: "firebase",
      intent: IntentType.data,
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
        "No agregues advertencias de falta de datos cuando la herramienta indique totalEvaluaciones mayor que 0 o tieneEvaluacionesValidas true.",
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

  let firstPayload;
  try {
    firstPayload = await callGroq(baseMessages, { tools: aiToolDefinitions });
  } catch (error) {
    const fallback = await localDatabaseAnswer(safeQuestion);
    if (fallback) return { ...fallback, memoryUsed: memoryMessages.length };
    if (isGroqLimitError(error)) {
      return {
        ok: true,
        mode: "groq_rate_limited",
        source: "ai",
        intent: IntentType.hybrid,
        answer: "**Tigre IA llego al limite temporal de Groq.** La base de datos sigue disponible, pero esta pregunta necesita generacion IA. Intenta nuevamente cuando se libere cuota o formula una consulta concreta de ranking/conteo para responderla directo desde Firebase.",
        memoryUsed: memoryMessages.length,
        toolsUsed: []
      };
    }
    throw error;
  }
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
    let finalPayload;
    try {
      finalPayload = await callGroq([
        ...baseMessages,
        ...toolMessages,
        {
          role: "user",
          content: "Con los resultados de herramientas anteriores, responde la pregunta de forma ejecutiva, accionable y sin inventar datos."
        }
      ]);
    } catch (error) {
      if (isGroqLimitError(error)) {
        const directLowestResult = toolsUsed.find(item => item.name === "get_lowest_advisors" || item.name === "get_advisor_score_ranking");
        if (directLowestResult) {
          const result = await executeAiTool("get_advisor_score_ranking", directLowestResult.args || {});
          return {
            ok: true,
            mode: "database_fallback",
            source: "firebase",
            intent: IntentType.data,
            answer: formatAdvisorRankingAnswer(result, directLowestResult.args?.order || "asc"),
            memoryUsed: memoryMessages.length,
            toolsUsed
          };
        }
        return {
          ok: true,
          mode: "groq_rate_limited",
          source: "ai",
          intent: IntentType.hybrid,
          answer: "**Tigre IA consulto Firebase, pero Groq llego al limite antes de redactar la conclusion.** Intenta nuevamente cuando se libere cuota.",
          memoryUsed: memoryMessages.length,
          toolsUsed
        };
      }
      throw error;
    }
    return {
      ok: true,
      mode: "groq",
      source: "ai",
      intent: IntentType.hybrid,
      model: config.groqModel,
      answer: extractGroqText(finalPayload) || "No pude generar una conclusion con la respuesta recibida.",
      memoryUsed: memoryMessages.length,
      toolsUsed
    };
  }

  return {
    ok: true,
    mode: "groq",
    source: "ai",
    intent: IntentType.ai,
    model: config.groqModel,
    answer: extractGroqText(firstPayload) || "No pude generar una conclusion con la respuesta recibida.",
    memoryUsed: memoryMessages.length,
    toolsUsed
  };
}

async function routeConsultantAnswer({ safeQuestion, context, memoryMessages }) {
  const intent = intentRouter.detectIntent(safeQuestion);
  if (intent === IntentType.data) {
    const answer = await localDatabaseAnswer(safeQuestion);
    return { ...answer, memoryUsed: memoryMessages.length };
  }
  if (intent === IntentType.hybrid) {
    if (!config.groqApiKey) {
      const answer = await localDatabaseAnswer(safeQuestion);
      return { ...answer, mode: "hybrid_firebase_only", source: "firebase", intent, memoryUsed: memoryMessages.length };
    }
    return generateHybridAnswer({ safeQuestion, memoryMessages, context });
  }
  if (intent === IntentType.ai) {
    if (!config.groqApiKey) {
      return {
        ok: true,
        mode: "local_fallback",
        source: "ai",
        intent,
        answer: localFallbackInsights(context, safeQuestion),
        memoryUsed: memoryMessages.length,
        toolsUsed: []
      };
    }
    return generateAiOnlyAnswer({ safeQuestion, memoryMessages });
  }
  return null;
}

function isGroqLimitError(error) {
  const text = normalizeAiText(error?.message || "");
  return error?.status === 429 || text.includes("rate limit") || text.includes("tokens per day") || text.includes("tokens per minute");
}

export async function generateDashboardInsights({ question = "", context = {}, messages = [] }) {
  const safeQuestion = String(question || "").trim().slice(0, 1200);
  const memoryMessages = sanitizeConversationMessages(messages);
  return routeConsultantAnswer({ safeQuestion, context, memoryMessages })
    || legacyToolAgentAnswer({ safeQuestion, context, memoryMessages });
}

