export const DEFAULT_QUALITY_VARIABLE_CONFIG = Object.freeze({
  version: 1,
  clientId: "entel_b2b",
  evaluationWeight: 30,
  evaluationTarget: 300,
  feedbackWeight: 30,
  feedbackTarget: 200,
  clinicInductionWeight: 10,
  clinicTarget: 4,
  inductionTarget: 2,
  tractionWeight: 30,
  tractionTarget: 10,
  baseCommission: 200,
  minimumPaymentCompliance: 85,
  overachievementBlock: 10,
  overachievementBonus: 30,
  overachievementEnabled: true,
  maximumCommission: null
});

const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const nonNegative = (value, fallback = 0) => Math.max(0, finite(value, fallback));

export function normalizeQualityVariableConfig(input = {}) {
  const defaults = DEFAULT_QUALITY_VARIABLE_CONFIG;
  return {
    ...defaults,
    ...input,
    clientId: "entel_b2b",
    evaluationWeight: nonNegative(input.evaluationWeight, defaults.evaluationWeight),
    evaluationTarget: nonNegative(input.evaluationTarget, defaults.evaluationTarget),
    feedbackWeight: nonNegative(input.feedbackWeight, defaults.feedbackWeight),
    feedbackTarget: nonNegative(input.feedbackTarget, defaults.feedbackTarget),
    clinicInductionWeight: nonNegative(input.clinicInductionWeight, defaults.clinicInductionWeight),
    clinicTarget: nonNegative(input.clinicTarget, defaults.clinicTarget),
    inductionTarget: nonNegative(input.inductionTarget, defaults.inductionTarget),
    tractionWeight: nonNegative(input.tractionWeight, defaults.tractionWeight),
    tractionTarget: nonNegative(input.tractionTarget, defaults.tractionTarget),
    baseCommission: nonNegative(input.baseCommission, defaults.baseCommission),
    minimumPaymentCompliance: nonNegative(input.minimumPaymentCompliance, defaults.minimumPaymentCompliance),
    overachievementBlock: nonNegative(input.overachievementBlock, defaults.overachievementBlock),
    overachievementBonus: nonNegative(input.overachievementBonus, defaults.overachievementBonus),
    overachievementEnabled: input.overachievementEnabled !== false,
    maximumCommission: input.maximumCommission === "" || input.maximumCommission === null || input.maximumCommission === undefined
      ? null
      : nonNegative(input.maximumCommission, 0)
  };
}

export function validateQualityVariableConfig(input = {}) {
  const config = normalizeQualityVariableConfig(input);
  const errors = [];
  const weightTotal = config.evaluationWeight + config.feedbackWeight + config.clinicInductionWeight + config.tractionWeight;
  if (Math.abs(weightTotal - 100) > 0.000001) errors.push(`La suma de pesos debe ser exactamente 100%. Actualmente suma ${weightTotal}%.`);
  if (!config.evaluationTarget) errors.push("La meta de evaluaciones debe ser mayor que cero.");
  if (!config.feedbackTarget) errors.push("La meta de feedbacks debe ser mayor que cero.");
  if (!config.clinicTarget) errors.push("La meta de clinicas debe ser mayor que cero.");
  if (!config.inductionTarget) errors.push("La meta de inducciones debe ser mayor que cero.");
  if (!config.tractionTarget) errors.push("La meta de traccion debe ser mayor que cero.");
  if (config.overachievementEnabled && !config.overachievementBlock) errors.push("El bloque de sobrecumplimiento debe ser mayor que cero.");
  return { ok: errors.length === 0, errors, config, weightTotal };
}

function ratio(value, target) {
  const safeTarget = nonNegative(target);
  return safeTarget > 0 ? nonNegative(value) / safeTarget : 0;
}

export function calculateQualityVariable(input = {}, rawConfig = {}) {
  const validation = validateQualityVariableConfig(rawConfig);
  if (!validation.ok) throw new Error(validation.errors.join(" "));
  const config = validation.config;
  const evaluations = nonNegative(input.evaluations);
  const feedbacks = nonNegative(input.feedbacks);
  const clinics = nonNegative(input.clinics);
  const inductions = nonNegative(input.inductions);
  const traction = nonNegative(input.traction);

  const evaluationCompliance = ratio(evaluations, config.evaluationTarget);
  const feedbackCompliance = ratio(feedbacks, config.feedbackTarget);
  const clinicCompliance = ratio(clinics, config.clinicTarget);
  const inductionCompliance = ratio(inductions, config.inductionTarget);
  const clinicInductionCompliance = Math.min(1, clinicCompliance, inductionCompliance);
  const tractionCompliance = ratio(traction, config.tractionTarget);

  const evaluationContribution = evaluationCompliance * config.evaluationWeight;
  const feedbackContribution = feedbackCompliance * config.feedbackWeight;
  const clinicInductionContribution = clinicInductionCompliance * config.clinicInductionWeight;
  const tractionContribution = tractionCompliance * config.tractionWeight;
  const totalCompliance = evaluationContribution + feedbackContribution + clinicInductionContribution + tractionContribution;
  const proportionalCommission = config.baseCommission * (totalCompliance / 100);
  const eligible = totalCompliance >= config.minimumPaymentCompliance;
  const overachievementBlocks = eligible && config.overachievementEnabled && totalCompliance >= 100
    ? Math.floor(((totalCompliance - 100) + 1e-9) / config.overachievementBlock)
    : 0;
  const overachievementBonus = overachievementBlocks * config.overachievementBonus;
  let totalCommission = 0;
  if (eligible) totalCommission = totalCompliance < 100 ? proportionalCommission : config.baseCommission + overachievementBonus;
  if (config.maximumCommission !== null) totalCommission = Math.min(totalCommission, config.maximumCommission);

  const label = totalCompliance < config.minimumPaymentCompliance
    ? "Sin comision"
    : totalCompliance < 100
      ? "Parcial"
      : totalCompliance < 110
        ? "Cumplido"
        : "Sobrecumplimiento";

  return {
    inputs: { evaluations, feedbacks, clinics, inductions, traction },
    compliance: {
      evaluations: evaluationCompliance * 100,
      feedbacks: feedbackCompliance * 100,
      clinics: clinicCompliance * 100,
      inductions: inductionCompliance * 100,
      clinicInduction: clinicInductionCompliance * 100,
      traction: tractionCompliance * 100,
      total: totalCompliance
    },
    contributions: {
      evaluations: evaluationContribution,
      feedbacks: feedbackContribution,
      clinicInduction: clinicInductionContribution,
      traction: tractionContribution
    },
    monetaryContributions: {
      evaluations: evaluationCompliance * (config.baseCommission * config.evaluationWeight / 100),
      feedbacks: feedbackCompliance * (config.baseCommission * config.feedbackWeight / 100),
      clinicInduction: clinicInductionCompliance * (config.baseCommission * config.clinicInductionWeight / 100),
      traction: tractionCompliance * (config.baseCommission * config.tractionWeight / 100)
    },
    proportionalCommission,
    eligible,
    overachievementBlocks,
    overachievementBonus,
    totalCommission,
    label,
    configSnapshot: { ...config }
  };
}

