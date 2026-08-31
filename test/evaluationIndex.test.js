import test from "node:test";
import assert from "node:assert/strict";
import { buildEvaluationIndexRecord } from "../server/gasHandlers.js";

test("el indice de evaluaciones conserva filtros y resultados sin duplicar el detalle", () => {
  const record = {
    id: "123",
    clientId: "entel_b2b",
    asesorNombre: "ASESOR PRUEBA",
    auditorId: "monitor.prueba",
    auditorNombre: "MONITOR PRUEBA",
    campaign: "RUC 10",
    fechaEvaluacion: "2026-08-31T10:00:00.000Z",
    resultadoGeneral: "80.0% - Cumple",
    detalleAuditadoGeneral: "Texto extenso que solo corresponde al detalle.",
    oportunidadMejoraGeneral: "Otra observacion extensa.",
    evidenciaGeneral: "Caso 999",
    files: [{ name: "audio.mp3", data: "contenido-pesado" }],
    secciones: [{
      nombreSeccion: "1.1 Saludo",
      criterio: "Texto estatico de la rubrica",
      resultado: "Cumple",
      detalleAuditado: "Comentario detallado del item",
      puntaje: 2,
      puntajeReponderado: 2,
      aporteReponderado: 2
    }],
    zeroToleranceItems: [{ subItem: "Privacidad", resultado: "No aplica", descripcion: "Texto estatico" }]
  };

  const compact = buildEvaluationIndexRecord(record);

  assert.equal(compact.asesorNombre, record.asesorNombre);
  assert.equal(compact.auditorNombre, record.auditorNombre);
  assert.equal(compact.resultadoGeneral, record.resultadoGeneral);
  assert.deepEqual(compact.secciones, [{
    nombreSeccion: "1.1 Saludo",
    resultado: "Cumple",
    puntaje: 2,
    puntajeReponderado: 2,
    aporteReponderado: 2
  }]);
  assert.deepEqual(compact.zeroToleranceItems, [{ subItem: "Privacidad", resultado: "No aplica" }]);
  assert.equal(Object.hasOwn(compact, "detalleAuditadoGeneral"), false);
  assert.equal(Object.hasOwn(compact, "oportunidadMejoraGeneral"), false);
  assert.equal(Object.hasOwn(compact, "files"), false);
});
