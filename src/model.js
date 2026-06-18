const CURRENCIES = ['PKR', 'USD', 'GBP', 'EUR', 'AED']
const STRATEGIES = ['distribution', 'profit_take', 'contribution']

const RULES = {
  investment: [1, 1_000_000_000],
  navPerUnit: [0.0001, 1_000_000],
  annualGrowth: [-95, 200],
  years: [1, 50],
  intervalMonths: [1, 120],
  reinvestPct: [0, 100],
  taxRate: [0, 80],
  managementFee: [0, 50],
  distributionYield: [0, 80],
  profitTakePct: [0, 100],
  contributionAmount: [0, 1_000_000_000],
  contributionFrequencyMonths: [1, 120],
}

function toNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

function roundMonths(value) {
  return Math.max(1, Math.round(Number(value) || 1))
}

function cleanNumber(key, value, fallback) {
  const [min, max] = RULES[key]
  return clamp(toNumber(value, fallback), min, max)
}

function cagr(finalValue, invested, years) {
  if (finalValue <= 0 || invested <= 0 || years <= 0) return 0
  return (Math.pow(finalValue / invested, 1 / years) - 1) * 100
}

function annualizedReturnFromCashflows(cashflows, fallbackFinalValue, invested, years) {
  if (!Array.isArray(cashflows) || cashflows.length < 2) return cagr(fallbackFinalValue, invested, years)
  const hasPositive = cashflows.some((value) => value > 0)
  const hasNegative = cashflows.some((value) => value < 0)
  if (!hasPositive || !hasNegative) return cagr(fallbackFinalValue, invested, years)

  const npv = (monthlyRate) => cashflows.reduce((sum, amount, month) => {
    if (!amount) return sum
    return sum + amount / Math.pow(1 + monthlyRate, month)
  }, 0)

  let low = -0.999999
  let high = 1
  let npvHigh = npv(high)
  let guard = 0
  while (npvHigh > 0 && high < 1_000 && guard < 40) {
    high *= 2
    npvHigh = npv(high)
    guard += 1
  }

  if (npv(low) * npvHigh > 0) return cagr(fallbackFinalValue, invested, years)

  for (let i = 0; i < 120; i++) {
    const mid = (low + high) / 2
    const value = npv(mid)
    if (value > 0) low = mid
    else high = mid
  }

  const monthlyRate = (low + high) / 2
  return (Math.pow(1 + monthlyRate, 12) - 1) * 100
}


function labelForMonth(month) {
  if (month === 0) return 'Start'
  if (month % 12 === 0) return `Y${month / 12}`
  return `M${month}`
}

export function normalizeParams(input = {}) {
  const fallback = {
    investment: 500000,
    navPerUnit: 100,
    annualGrowth: 15,
    years: 5,
    intervalMonths: 6,
    reinvestPct: 100,
    taxRate: 0,
    managementFee: 0.5,
    distributionYield: 6,
    profitTakePct: 100,
    contributionAmount: 25000,
    contributionFrequencyMonths: 1,
    strategy: 'distribution',
    currency: 'PKR',
  }

  const merged = { ...fallback, ...input }
  const out = {}
  for (const key of Object.keys(RULES)) out[key] = cleanNumber(key, merged[key], fallback[key])

  out.years = Math.round(out.years * 12) / 12
  out.intervalMonths = roundMonths(out.intervalMonths)
  out.contributionFrequencyMonths = roundMonths(out.contributionFrequencyMonths)
  out.strategy = STRATEGIES.includes(merged.strategy) ? merged.strategy : fallback.strategy
  out.currency = CURRENCIES.includes(merged.currency) ? merged.currency : fallback.currency

  return out
}

function createSnapshot(month, nav, hold, strategy, meta = {}) {
  const holdPortfolio = hold.units * nav
  const strategyPortfolio = strategy.units * nav
  return {
    month,
    label: labelForMonth(month),
    nav,
    holdPortfolio,
    holdCash: hold.cash,
    holdTotal: holdPortfolio + hold.cash,
    strategyPortfolio,
    strategyCash: strategy.cash,
    strategyTotal: strategyPortfolio + strategy.cash,
    strategyUnits: strategy.units,
    holdUnits: hold.units,
    totalInvested: strategy.totalInvested,
    ...meta,
  }
}

/**
 * runModel — realistic NAV strategy simulator.
 *
 * The old version created new units from unrealized NAV appreciation. This one
 * only creates cash when a real-world event creates cash:
 * 1) a fund distribution/dividend, 2) selling units, or 3) adding new money.
 */
export function runModel(rawParams) {
  const p = normalizeParams(rawParams)
  const warnings = []
  const totalMonths = Math.max(1, Math.round(p.years * 12))

  const effectiveAnnualGrowthPct = p.annualGrowth - p.managementFee
  let effectiveGrowth = effectiveAnnualGrowthPct / 100
  if (effectiveGrowth <= -0.99) {
    warnings.push('Annual growth minus fee was too low, so the model was clamped above -100% to avoid impossible NAV math.')
    effectiveGrowth = -0.99
  }
  const monthlyGrowth = Math.pow(1 + effectiveGrowth, 1 / 12) - 1

  let nav = p.navPerUnit
  const hold = {
    units: p.investment / p.navPerUnit,
    cash: 0,
    taxPaid: 0,
    totalInvested: p.investment,
  }
  const strategy = {
    units: p.investment / p.navPerUnit,
    cash: 0,
    taxPaid: 0,
    totalInvested: p.investment,
    costBasis: p.investment,
  }

  const events = []
  const dataPoints = [createSnapshot(0, nav, hold, strategy)]
  const holdCashflows = Array(totalMonths + 1).fill(0)
  const strategyCashflows = Array(totalMonths + 1).fill(0)
  holdCashflows[0] = -p.investment
  strategyCashflows[0] = -p.investment

  for (let month = 1; month <= totalMonths; month++) {
    nav *= (1 + monthlyGrowth)

    if (p.strategy === 'distribution' && month % p.intervalMonths === 0) {
      const periodRate = Math.min(0.95, (p.distributionYield / 100) * (p.intervalMonths / 12))
      if (periodRate > 0) {
        const navBefore = nav
        const distributionPerUnit = navBefore * periodRate
        const navAfter = Math.max(0.0001, navBefore - distributionPerUnit)

        const holdGross = hold.units * distributionPerUnit
        const holdTax = holdGross * (p.taxRate / 100)
        const holdCash = Math.max(0, holdGross - holdTax)
        hold.cash += holdCash
        hold.taxPaid += holdTax
        holdCashflows[month] += holdCash

        const strategyGross = strategy.units * distributionPerUnit
        const strategyTax = strategyGross * (p.taxRate / 100)
        const strategyAfterTax = Math.max(0, strategyGross - strategyTax)
        const reinvested = strategyAfterTax * (p.reinvestPct / 100)
        const withdrawn = strategyAfterTax - reinvested
        const newUnits = reinvested / navAfter

        strategy.units += newUnits
        strategy.cash += withdrawn
        strategy.taxPaid += strategyTax
        strategyCashflows[month] += withdrawn
        strategy.costBasis += reinvested
        nav = navAfter

        events.push({
          type: 'Distribution',
          month,
          navBefore,
          navAfter,
          grossCash: strategyGross,
          tax: strategyTax,
          afterTaxCash: strategyAfterTax,
          reinvested,
          withdrawn,
          newUnits,
          unitsSold: 0,
          totalUnits: strategy.units,
          note: 'Cash came from an actual distribution. NAV was reduced by the distribution amount.',
        })
      }
    }

    if (p.strategy === 'profit_take' && month % p.intervalMonths === 0) {
      const portfolioValue = strategy.units * nav
      const unrealizedProfit = Math.max(0, portfolioValue - strategy.costBasis)
      const grossSale = Math.min(portfolioValue, unrealizedProfit * (p.profitTakePct / 100))

      if (grossSale > 0 && strategy.units > 0) {
        const unitsSold = grossSale / nav
        const costPerUnit = strategy.costBasis / strategy.units
        const taxableGain = Math.max(0, nav - costPerUnit) * unitsSold
        const tax = taxableGain * (p.taxRate / 100)
        const afterTaxCash = Math.max(0, grossSale - tax)
        const costBasisRemoved = costPerUnit * unitsSold

        strategy.units = Math.max(0, strategy.units - unitsSold)
        strategy.cash += afterTaxCash
        strategy.taxPaid += tax
        strategyCashflows[month] += afterTaxCash
        strategy.costBasis = Math.max(0, strategy.costBasis - costBasisRemoved)

        events.push({
          type: 'Profit sale',
          month,
          navBefore: nav,
          navAfter: nav,
          grossCash: grossSale,
          tax,
          afterTaxCash,
          reinvested: 0,
          withdrawn: afterTaxCash,
          newUnits: 0,
          unitsSold,
          totalUnits: strategy.units,
          taxableGain,
          note: 'Cash came from selling units, so unit count and cost basis were reduced.',
        })
      }
    }

    if (p.strategy === 'contribution' && month % p.contributionFrequencyMonths === 0 && p.contributionAmount > 0) {
      const newUnits = p.contributionAmount / nav
      strategy.units += newUnits
      strategy.totalInvested += p.contributionAmount
      strategy.costBasis += p.contributionAmount
      strategyCashflows[month] -= p.contributionAmount

      events.push({
        type: 'Contribution',
        month,
        navBefore: nav,
        navAfter: nav,
        grossCash: p.contributionAmount,
        tax: 0,
        afterTaxCash: p.contributionAmount,
        reinvested: p.contributionAmount,
        withdrawn: 0,
        newUnits,
        unitsSold: 0,
        totalUnits: strategy.units,
        note: 'New units came from new outside money, not from unrealized profit.',
      })
    }

    dataPoints.push(createSnapshot(month, nav, hold, strategy))
  }

  const last = dataPoints[dataPoints.length - 1]
  const holdFinal = last.holdTotal
  const strategyFinal = last.strategyTotal
  holdCashflows[totalMonths] += last.holdPortfolio
  strategyCashflows[totalMonths] += last.strategyPortfolio
  const holdAnnualizedReturn = annualizedReturnFromCashflows(holdCashflows, holdFinal, p.investment, p.years)
  const strategyAnnualizedReturn = annualizedReturnFromCashflows(strategyCashflows, strategyFinal, strategy.totalInvested, p.years)
  const holdEndingWealthCAGR = cagr(holdFinal, p.investment, p.years)
  const strategyEndingWealthCAGR = cagr(strategyFinal, strategy.totalInvested, p.years)
  const holdNetGain = holdFinal - p.investment
  const strategyNetGain = strategyFinal - strategy.totalInvested
  const winner = strategyNetGain >= holdNetGain ? 'strategy' : 'hold'

  if (p.strategy === 'contribution') {
    warnings.push('Recurring contribution mode is not an apples-to-apples ending-value comparison because the strategy adds new money. Compare net gain and return on contributed amount, not only final value.')
  }
  if (p.strategy === 'distribution' && p.distributionYield === 0) {
    warnings.push('Distribution yield is 0%, so there is no distribution cash to reinvest. The strategy will behave almost like Buy & Hold.')
  }
  if (p.strategy === 'profit_take' && p.profitTakePct === 0) {
    warnings.push('Profit-sale percentage is 0%, so the strategy will not sell units or take profits.')
  }

  return {
    params: p,
    dataPoints,
    events,
    warnings,
    summary: {
      investment: p.investment,
      strategy,
      holdFinal,
      strategyFinal,
      holdPortfolio: last.holdPortfolio,
      strategyPortfolio: last.strategyPortfolio,
      holdCash: hold.cash,
      strategyCash: strategy.cash,
      totalWithdrawn: strategy.cash,
      totalTaxPaid: hold.taxPaid + strategy.taxPaid,
      strategyTaxPaid: strategy.taxPaid,
      holdTaxPaid: hold.taxPaid,
      totalInvested: strategy.totalInvested,
      extraInvested: strategy.totalInvested - p.investment,
      holdNetGain,
      strategyNetGain,
      holdReturn: (holdNetGain / p.investment) * 100,
      strategyReturn: (strategyNetGain / strategy.totalInvested) * 100,
      holdAnnualizedReturn,
      strategyAnnualizedReturn,
      holdEndingWealthCAGR,
      strategyEndingWealthCAGR,
      finalNAV: last.nav,
      holdUnits: hold.units,
      strategyUnits: strategy.units,
      winner,
      margin: Math.abs(holdNetGain - strategyNetGain),
      years: p.years,
      totalMonths,
      effectiveAnnualGrowthPct,
      monthlyGrowthPct: monthlyGrowth * 100,
      eventsCount: events.length,
    },
  }
}

// Format a number as PKR (crore/lakh) or generic currency. This is display only.
export function fmt(n, currency = 'PKR') {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const value = Number(n)
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (currency === 'PKR') {
    if (abs >= 10_000_000) return `${sign}PKR ${(abs / 10_000_000).toFixed(2)} Cr`
    if (abs >= 100_000) return `${sign}PKR ${(abs / 100_000).toFixed(2)} L`
    return `${sign}PKR ${Math.round(abs).toLocaleString()}`
  }
  if (abs >= 1_000_000) return `${sign}${currency} ${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}${currency} ${(abs / 1_000).toFixed(1)}K`
  return `${sign}${currency} ${Math.round(abs).toLocaleString()}`
}

export function pct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `${Number(n).toFixed(2)}%`
}

export function paramsToURL(params) {
  const p = normalizeParams(params)
  return '?' + new URLSearchParams(
    Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]))
  ).toString()
}

export function paramsFromURL(defaults) {
  const query = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const out = { ...defaults }
  for (const key of Object.keys(defaults)) {
    if (query.has(key)) out[key] = query.get(key)
  }
  return normalizeParams(out)
}
