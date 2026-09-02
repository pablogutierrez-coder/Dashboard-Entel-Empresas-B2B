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
    assert.equal(record.statisticalOnly, true);
    assert.equal(record.operational, false);
    assert.equal(record.authorUser, "monitor.demo");
    assert.equal(record.advisorUser, "");
    assert.equal(record.supervisorUser, "");
    assert.deepEqual(record.messages, []);
    assert.deepEqual(record.files, []);
    assert.equal(record.compromisoMejora, undefined);
    assert.equal(record.evaluationId, undefined);
    assert.equal(record.status, "statistical");
  });
  assert.equal(source.advisorUser, "asesor.real");
  assert.equal(source.compromisoMejora, "Compromiso operativo");
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
