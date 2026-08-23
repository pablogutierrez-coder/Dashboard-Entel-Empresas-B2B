import test from "node:test";
import assert from "node:assert/strict";
import { calculateQualityVariable, validateQualityVariableConfig } from "../server/qualityVariable.js";

const config = { evaluationWeight: 30, feedbackWeight: 30, clinicInductionWeight: 10, tractionWeight: 30 };
const commissionFor = total => calculateQualityVariable(
  { evaluations: total, feedbacks: 0, clinics: 0, inductions: 0, traction: 0 },
  { evaluationWeight: 100, feedbackWeight: 0, clinicInductionWeight: 0, tractionWeight: 0, evaluationTarget: 100 }
).totalCommission;

test("cumplimiento 82.50 no genera comision", () => assert.equal(commissionFor(82.5), 0));
test("cumplimiento 85 genera S/170", () => assert.equal(commissionFor(85), 170));
test("cumplimiento 90 genera S/180", () => assert.equal(commissionFor(90), 180));
test("cumplimiento 100 genera S/200", () => assert.equal(commissionFor(100), 200));
test("cumplimiento 105 no genera bloque incompleto", () => assert.equal(commissionFor(105), 200));
test("cumplimiento 109.99 no genera bloque incompleto", () => assert.equal(commissionFor(109.99), 200));
test("cumplimiento 110 genera S/230", () => assert.equal(commissionFor(110), 230));
test("cumplimiento 120 genera S/260", () => assert.equal(commissionFor(120), 260));
test("cumplimiento 150 genera S/350", () => assert.equal(commissionFor(150), 350));

test("4 clinicas y 0 inducciones generan 0%", () => {
  const result = calculateQualityVariable({ clinics: 4, inductions: 0 }, config);
  assert.equal(result.compliance.clinicInduction, 0);
});

test("2 clinicas y 2 inducciones generan 50%", () => {
  const result = calculateQualityVariable({ clinics: 2, inductions: 2 }, config);
  assert.equal(result.compliance.clinicInduction, 50);
});

test("250 de 300 evaluaciones generan 83.33%", () => {
  const result = calculateQualityVariable({ evaluations: 250 }, config);
  assert.ok(Math.abs(result.compliance.evaluations - 83.3333333333) < 0.00001);
});

test("150 de 200 feedbacks generan 75%", () => {
  const result = calculateQualityVariable({ feedbacks: 150 }, config);
  assert.equal(result.compliance.feedbacks, 75);
});

test("traccion de 10 con meta 10 genera 100%", () => {
  const result = calculateQualityVariable({ traction: 10 }, config);
  assert.equal(result.compliance.traction, 100);
});

test("rechaza pesos cuya suma no es 100", () => {
  const result = validateQualityVariableConfig({ ...config, tractionWeight: 20 });
  assert.equal(result.ok, false);
});
