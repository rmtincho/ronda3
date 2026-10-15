// Reglas de puntaje. Solo el servidor calcula puntos.
const { isMatch } = require('./matching');

const SPEED_MIN = 500;
const SPEED_MAX = 1000;
const PRECISION_MAX = 1000;
const CLOSEST_BONUS = 200;
const STREAK_STEP = 100;
const STREAK_CAP = 500;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Acertar al instante vale 1000; al último segundo, 500.
function speedPoints(remainingMs, durationMs) {
  return Math.round(SPEED_MIN + (SPEED_MAX - SPEED_MIN) * clamp(remainingMs / durationMs, 0, 1));
}

// Lineal: exacto vale 1000; errarle por `tolerance` o más vale 0.
function precisionPoints(value, answer, tolerance) {
  return Math.round(PRECISION_MAX * Math.max(0, 1 - Math.abs(value - answer) / tolerance));
}

// Segundo acierto seguido: +100, tercero: +200… hasta +500.
function streakBonus(streak) {
  return streak >= 2 ? Math.min(STREAK_CAP, STREAK_STEP * (streak - 1)) : 0;
}

// entries: [{ key, answer: { value, at } | null }]
// Devuelve [{ key, answered, correct, points, closest?, diff? }]. `correct` alimenta la racha.
function scoreAnswers(spec, entries, { endsAt, durationMs }) {
  if (spec.inputType === 'number') {
    const { answer, tolerance } = spec.numeric;
    const diffs = entries.filter((e) => e.answer).map((e) => Math.abs(e.answer.value - answer));
    const best = diffs.length ? Math.min(...diffs) : null;
    return entries.map((e) => {
      if (!e.answer) return { key: e.key, answered: false, correct: false, points: 0 };
      const diff = Math.abs(e.answer.value - answer);
      let points = precisionPoints(e.answer.value, answer, tolerance);
      const closest = diff === best && points > 0;
      if (closest) points += CLOSEST_BONUS;
      return { key: e.key, answered: true, correct: closest, closest, points, diff };
    });
  }

  return entries.map((e) => {
    if (!e.answer) return { key: e.key, answered: false, correct: false, points: 0 };
    const correct = spec.inputType === 'choice'
      ? e.answer.value === spec.correctOptionId
      : isMatch(e.answer.value, spec.candidates, { names: spec.matchNames });
    const points = correct ? speedPoints(endsAt - e.answer.at, durationMs) : 0;
    return { key: e.key, answered: true, correct, points };
  });
}

module.exports = { scoreAnswers, streakBonus, speedPoints, precisionPoints };
