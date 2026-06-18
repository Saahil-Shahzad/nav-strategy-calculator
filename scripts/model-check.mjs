import assert from 'node:assert/strict'
import { runModel } from '../src/model.js'

const nearlyEqual = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance
const finite = (value) => Number.isFinite(value)

function assertFiniteSummary(model) {
  const { summary, dataPoints, events } = model
  assert.ok(dataPoints.length === summary.totalMonths + 1, 'one snapshot per simulated month plus start')
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === 'number') assert.ok(finite(value), `summary.${key} must be finite`)
  }
  for (const point of dataPoints) {
    for (const key of ['nav', 'holdPortfolio', 'holdTotal', 'strategyPortfolio', 'strategyTotal', 'strategyUnits', 'holdUnits']) {
      assert.ok(finite(point[key]), `data point ${point.month}.${key} must be finite`)
      assert.ok(point[key] >= 0, `data point ${point.month}.${key} must not be negative`)
    }
  }
  for (const event of events) {
    assert.ok(event.month > 0 && event.month <= summary.totalMonths, 'event month must be inside simulation')
    assert.ok(event.totalUnits >= 0, 'event total units must not be negative')
    assert.ok(event.navAfter > 0, 'event NAV must stay positive')
  }
}

// 1) Zero distribution should behave exactly like simple Buy & Hold.
{
  const model = runModel({ strategy: 'distribution', distributionYield: 0, reinvestPct: 100, taxRate: 0 })
  assertFiniteSummary(model)
  assert.equal(model.events.length, 0)
  assert.ok(nearlyEqual(model.summary.holdFinal, model.summary.strategyFinal))
  assert.ok(nearlyEqual(model.summary.holdUnits, model.summary.strategyUnits))
}

// 2) If a distribution is fully reinvested with no tax, total wealth should match the same fund with no distribution.
{
  const noDistribution = runModel({ strategy: 'distribution', distributionYield: 0, reinvestPct: 100, taxRate: 0 })
  const fullReinvest = runModel({ strategy: 'distribution', distributionYield: 6, reinvestPct: 100, taxRate: 0 })
  assertFiniteSummary(fullReinvest)
  assert.ok(nearlyEqual(fullReinvest.summary.strategyFinal, noDistribution.summary.strategyFinal, 1e-5))
  assert.ok(nearlyEqual(fullReinvest.summary.strategyAnnualizedReturn, noDistribution.summary.strategyAnnualizedReturn, 1e-8))
}

// 3) If distributions are not reinvested, the strategy and Buy & Hold receive the same cash and should match.
{
  const model = runModel({ strategy: 'distribution', distributionYield: 6, reinvestPct: 0, taxRate: 0 })
  assertFiniteSummary(model)
  assert.ok(nearlyEqual(model.summary.holdFinal, model.summary.strategyFinal, 1e-5))
  assert.ok(nearlyEqual(model.summary.holdCash, model.summary.strategyCash, 1e-5))
}

// 4) Profit-taking must sell units; it must not create cash while unit count stays unchanged.
{
  const model = runModel({ strategy: 'profit_take', profitTakePct: 100, annualGrowth: 15, taxRate: 0 })
  assertFiniteSummary(model)
  assert.ok(model.events.length > 0)
  assert.ok(model.summary.strategyUnits < model.summary.holdUnits, 'profit-taking must reduce units')
  assert.ok(model.summary.strategyCash > 0, 'profit-taking must create cash from sold units')
}

// 5) Recurring contribution mode must track extra invested money separately.
{
  const model = runModel({ strategy: 'contribution', contributionAmount: 25000, contributionFrequencyMonths: 1, years: 5 })
  assertFiniteSummary(model)
  assert.equal(model.events.length, 60)
  assert.equal(model.summary.extraInvested, 1_500_000)
  assert.ok(model.summary.strategyFinal > model.summary.holdFinal)
}

// 6) Pathological URL/input values must normalize instead of producing NaN/Infinity.
{
  const model = runModel({
    investment: 'abc',
    navPerUnit: 0,
    annualGrowth: -500,
    managementFee: 999,
    years: -10,
    intervalMonths: 0,
    taxRate: 999,
    strategy: 'unknown',
  })
  assertFiniteSummary(model)
  assert.ok(model.summary.finalNAV > 0)
}

// 7) Randomized smoke test across strategies and edge-ish values.
for (let i = 0; i < 300; i++) {
  const strategies = ['distribution', 'profit_take', 'contribution']
  const strategy = strategies[i % strategies.length]
  const model = runModel({
    strategy,
    investment: 1 + Math.random() * 10_000_000,
    navPerUnit: 0.01 + Math.random() * 1000,
    annualGrowth: -30 + Math.random() * 90,
    years: 1 + Math.random() * 29,
    intervalMonths: 1 + Math.floor(Math.random() * 24),
    reinvestPct: Math.random() * 100,
    taxRate: Math.random() * 40,
    managementFee: Math.random() * 5,
    distributionYield: Math.random() * 25,
    profitTakePct: Math.random() * 100,
    contributionAmount: Math.random() * 100_000,
    contributionFrequencyMonths: 1 + Math.floor(Math.random() * 24),
  })
  assertFiniteSummary(model)
}

console.log('Model checks passed')
