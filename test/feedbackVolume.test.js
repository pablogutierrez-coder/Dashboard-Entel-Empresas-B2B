import assert from "node:assert/strict";
import test from "node:test";
import { buildFeedbackVolumeRecords, gasHandlers } from "../server/gasHandlers.js";

test("el volumen de feedbacks queda aislado del flujo operativo", () => {
  const source = {
    id: 42,
    assessor: "ASESOR DEMO",
    advisorUser: "asesor.real",
    supervisorUser: "supervisor.real",
    compromisoMejora: "Compromiso operativo",
    evaluationId: "eval-42",
    messages: [{text:"mensaje real"}],
    files: [{name:"audio.mp3"}],
    feedbackCategory: "Feedback",
    status: "pending",
    estado: "pending",
    clientId: "entel-b2b"
  };

  const records = buildFeedbackVolumeRecords({
    operationalRecords:[source],
    quantity:3,
    monitor:{nombre:"Monitor Demo"},
    monitorUser:"monitor.demo",
    feedbackDate:"2026-09-02",
    month:"2026-09",
    clientId:"entel-b2b",
    clientName:"Entel Empresas B2B",
    createdBy:"admin.demo",
    now:"2026-09-02T12:00:00.000Z",
    batchId:"volume_test"
  });

  assert.equal(records.length, 3);
  records.forEach(record => {
    assert.equal(record.recordType, "feedback_volume");
    assert.equal(record.copySchemaVersion, 2);
    assert.equal(record.statisticalOnly, true);
    assert.equal(record.operational, false);
    assert.equal(record.workflowEnabled, false);
    assert.equal(record.advisorVisible, false);
    assert.equal(record.generatesCommitments, false);
    assert.equal(record.generatesTasks, false);
    assert.equal(record.generatesAlerts, false);
    assert.equal(record.affectsEvaluations, false);
    assert.equal(record.authorUser, "monitor.demo");
    assert.equal(record.advisorUser, source.advisorUser);
    assert.equal(record.supervisorUser, source.supervisorUser);
    assert.deepEqual(record.messages, source.messages);
    assert.deepEqual(record.files, source.files);
    assert.equal(record.compromisoMejora, source.compromisoMejora);
    assert.equal(record.evaluationId, source.evaluationId);
    assert.equal(record.status, source.status);
  });
  const generatedDates = records.map(record => record.feedbackDate);
  assert.equal(new Set(generatedDates).size, records.length);
  assert.deepEqual(generatedDates, [
    "2026-09-02T13:00:00.000Z",
    "2026-09-02T17:59:00.000Z",
    "2026-09-02T22:59:00.000Z"
  ]);
  assert.equal(source.advisorUser, "asesor.real");
  assert.equal(source.compromisoMejora, "Compromiso operativo");
  assert.equal(source.recordType, undefined);
});

test("el Dashboard no repite horas usadas por lotes anteriores", () => {
  const records = buildFeedbackVolumeRecords({
    operationalRecords:[{id:7,assessor:"ASESOR DEMO",status:"pending"}],
    existingRecords:[{feedbackDate:"2026-09-02T13:00:00.000Z"}],
    quantity:2,
    monitor:{nombre:"Monitor Demo"},
    monitorUser:"monitor.demo",
    feedbackDate:"2026-09-02",
    month:"2026-09",
    clientId:"entel-b2b",
    clientName:"Entel Empresas B2B",
    createdBy:"admin.demo",
    now:"2026-09-02T12:00:00.000Z",
    batchId:"volume_second_batch"
  });

  assert.equal(records[0].feedbackDate,"2026-09-02T13:01:00.000Z");
  assert.equal(records[1].feedbackDate,"2026-09-02T22:59:00.000Z");
  assert.equal(new Set(records.map(record => record.feedbackDate)).size,records.length);
});

test("solo Administrador puede ejecutar volumen y Supervisor no puede modificar feedbacks", async () => {
  await assert.rejects(
    gasHandlers.createFeedbackVolume({
      currentUser:{usuario:"supervisor.demo",rol:"supervisor"},
      monitorUser:"monitor.demo",
      quantity:1,
      feedbackDate:"2026-09-02",
      month:"2026-09"
    }),
    /Solo un administrador/
  );
  await assert.rejects(
    gasHandlers.updateFeedbackRecord({
      currentUser:{usuario:"supervisor.demo",rol:"supervisor"},
      id:1,
      action:"close_feedback"
    }),
    /solo lectura/
  );
});
