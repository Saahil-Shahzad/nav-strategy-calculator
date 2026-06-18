import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { fmt, normalizeParams, paramsFromURL, paramsToURL, pct, runModel } from './model.js'

const DEFAULTS = {
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

const STRATEGY_COPY = {
  distribution: {
    title: 'Distribution reinvestment',
    short: 'Realistic dividend/profit-distribution mode. NAV drops when cash is paid, then the selected % can buy more units.',
    resultLabel: 'Distribution strategy',
  },
  profit_take: {
    title: 'Sell units to take profit',
    short: 'Profit cash comes from selling units. This fixes the old impossible “withdraw profit without selling” behavior.',
    resultLabel: 'Profit-taking strategy',
  },
  contribution: {
    title: 'Recurring new investment',
    short: 'New units are bought with outside money on a schedule. Final value is larger because more money is invested.',
    resultLabel: 'Contribution strategy',
  },
}

function formatNumberInput(value) {
  return Number.isFinite(Number(value)) ? value : ''
}

function NumberField({ label, value, onChange, min, max, step = 1, help, suffix }) {
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        {suffix ? <span className="slider-value">{suffix}</span> : null}
      </label>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={formatNumberInput(value)}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {help ? <p className="help">{help}</p> : null}
    </div>
  )
}

function SelectField({ label, value, onChange, children, help }) {
  return (
    <div className="field">
      <label><span>{label}</span></label>
      <select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>
      {help ? <p className="help">{help}</p> : null}
    </div>
  )
}

function Slider({ label, value, min, max, step, onChange, display, help }) {
  return (
    <div>
      <div className="slider-label">
        <span>{label}</span>
        <span className="slider-value">{display ? display(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {help ? <p className="help">{help}</p> : null}
    </div>
  )
}

function findNavCandidate(data, depth = 0, path = '') {
  if (!data || depth > 4) return null

  const preferred = ['nav', 'NAV', 'net_asset_value', 'navPerUnit', 'price', 'close', 'regularMarketPrice']
  if (typeof data === 'object' && !Array.isArray(data)) {
    for (const key of preferred) {
      if (data[key] != null && Number.isFinite(Number(data[key]))) {
        return { value: Number(data[key]), path: path ? `${path}.${key}` : key }
      }
    }
  }

  if (Array.isArray(data)) {
    for (let i = 0; i < Math.min(data.length, 5); i++) {
      const found = findNavCandidate(data[i], depth + 1, `${path}[${i}]`)
      if (found) return found
    }
    return null
  }

  if (typeof data === 'object') {
    for (const [key, value] of Object.entries(data).slice(0, 40)) {
      const found = findNavCandidate(value, depth + 1, path ? `${path}.${key}` : key)
      if (found) return found
    }
  }

  return null
}

function NavFetch({ onFetched }) {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState(null)
  const [message, setMessage] = useState('')

  const fetchWithTimeout = async (target) => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 7000)
    try {
      const response = await fetch(target, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } finally {
      window.clearTimeout(timeout)
    }
  }

  const doFetch = async () => {
    if (!/^https?:\/\//i.test(url.trim())) {
      setStatus('err')
      setMessage('URL must start with http:// or https://')
      return
    }

    setStatus('loading')
    setMessage('Checking the direct API first…')

    const attempts = [
      { target: url.trim(), viaProxy: false },
      { target: `https://api.allorigins.win/get?url=${encodeURIComponent(url.trim())}`, viaProxy: true },
    ]

    for (const attempt of attempts) {
      try {
        let data = await fetchWithTimeout(attempt.target)
        if (data?.contents) data = JSON.parse(data.contents)
        const found = findNavCandidate(data)
        if (found) {
          setStatus('ok')
          setMessage(`NAV ${found.value} found at “${found.path}”${attempt.viaProxy ? ' via public CORS proxy' : ''}. Confirm this is the correct fund NAV.`)
          onFetched(found.value)
          return
        }
        setStatus('err')
        setMessage('The API responded, but I could not identify a NAV-like field. Enter NAV manually.')
        return
      } catch (error) {
        if (!attempt.viaProxy) {
          setMessage('Direct fetch failed, trying public CORS proxy…')
        }
      }
    }

    setStatus('err')
    setMessage('Could not fetch NAV. Enter it manually, or use a JSON API with a clear nav/price field.')
  }

  return (
    <div className="nav-fetch">
      <div className="nav-fetch-row">
        <input
          className="nav-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Paste JSON NAV API URL"
        />
        <button className="button-secondary" onClick={doFetch} disabled={status === 'loading'}>
          {status === 'loading' ? 'Fetching…' : 'Fetch NAV'}
        </button>
      </div>
      <p className={`status ${status || ''}`}>
        {message || 'Optional. For private APIs, avoid the proxy fallback and enter NAV manually.'}
      </p>
    </div>
  )
}

function Metric({ label, value, sub, tone }) {
  return (
    <div className={`metric ${tone || ''}`}>
      <p className="metric-label">{label}</p>
      <p className="metric-value">{value}</p>
      {sub ? <p className="metric-sub">{sub}</p> : null}
    </div>
  )
}

function SimpleChart({ data, currency }) {
  const width = 920
  const height = 310
  const pad = { top: 18, right: 22, bottom: 38, left: 92 }
  const innerWidth = width - pad.left - pad.right
  const innerHeight = height - pad.top - pad.bottom

  const safeData = data.length ? data : [{ label: 'Start', holdTotal: 0, strategyTotal: 0, strategyPortfolio: 0 }]
  const maxValue = Math.max(
    1,
    ...safeData.flatMap((point) => [point.holdTotal, point.strategyTotal, point.strategyPortfolio].map((value) => Number(value) || 0))
  )
  const minValue = Math.min(
    0,
    ...safeData.flatMap((point) => [point.holdTotal, point.strategyTotal, point.strategyPortfolio].map((value) => Number(value) || 0))
  )
  const span = Math.max(1, maxValue - minValue)
  const yMax = maxValue + span * 0.08
  const yMin = Math.min(0, minValue - span * 0.08)
  const ySpan = Math.max(1, yMax - yMin)

  const xFor = (index) => pad.left + (safeData.length === 1 ? 0 : (index / (safeData.length - 1)) * innerWidth)
  const yFor = (value) => pad.top + innerHeight - ((Number(value) - yMin) / ySpan) * innerHeight
  const pathFor = (key) => safeData.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index).toFixed(2)} ${yFor(point[key]).toFixed(2)}`).join(' ')
  const yTicks = Array.from({ length: 5 }, (_, index) => yMin + (ySpan * index) / 4)
  const xTicks = safeData.length <= 8
    ? safeData.map((point, index) => ({ point, index }))
    : safeData.filter((_, index) => index === 0 || index === safeData.length - 1 || index % Math.ceil(safeData.length / 6) === 0).map((point) => ({ point, index: safeData.indexOf(point) }))

  return (
    <div className="svg-chart" role="img" aria-label="Portfolio value line chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <rect x="0" y="0" width={width} height={height} rx="16" className="chart-bg" />
        {yTicks.map((tick) => {
          const y = yFor(tick)
          return (
            <g key={tick}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} className="chart-grid" />
              <text x={pad.left - 10} y={y + 4} textAnchor="end" className="chart-tick">{fmt(tick, currency)}</text>
            </g>
          )
        })}
        {xTicks.map(({ point, index }) => (
          <text key={`${point.label}-${index}`} x={xFor(index)} y={height - 14} textAnchor={index === 0 ? 'start' : index === safeData.length - 1 ? 'end' : 'middle'} className="chart-tick">
            {point.label}
          </text>
        ))}
        <path d={pathFor('holdTotal')} className="chart-line hold" />
        <path d={pathFor('strategyTotal')} className="chart-line strategy" />
        <path d={pathFor('strategyPortfolio')} className="chart-line portfolio" />
      </svg>
      <div className="legend-row" aria-hidden="true">
        <span><i className="legend-dot hold" />Buy & Hold total</span>
        <span><i className="legend-dot strategy" />Strategy total</span>
        <span><i className="legend-dot portfolio" />Strategy portfolio only</span>
      </div>
    </div>
  )
}

function sampleChartData(points, years) {
  const step = years <= 3 ? 1 : years <= 7 ? 3 : 6
  const lastMonth = points[points.length - 1]?.month
  return points.filter((point) => point.month === 0 || point.month === lastMonth || point.month % step === 0)
}

function EventTable({ events, currency, strategy }) {
  if (!events.length) {
    return <div className="banner blue">No strategy events happened with the current settings.</div>
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Month</th>
            <th>Type</th>
            <th>NAV</th>
            <th>Cash event</th>
            <th>Tax</th>
            {strategy === 'profit_take' ? <th>Units sold</th> : <th>New units</th>}
            <th>Total units</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, index) => (
            <tr key={`${event.type}-${event.month}-${index}`}>
              <td>{event.month}m</td>
              <td>{event.type}</td>
              <td>{event.navAfter.toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
              <td>{fmt(event.afterTaxCash, currency)}</td>
              <td>{fmt(event.tax, currency)}</td>
              {strategy === 'profit_take'
                ? <td>-{event.unitsSold.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                : <td>+{event.newUnits.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>}
              <td>{event.totalUnits.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function App() {
  const [params, setParams] = useState(() => paramsFromURL(DEFAULTS))
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('nav-calculator-theme')
    if (saved) return saved === 'dark'
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
  })
  const [showAdvanced, setShowAdvanced] = useState(true)
  const [showTable, setShowTable] = useState(false)

  const updateParam = useCallback((key, value) => {
    setParams((previous) => normalizeParams({ ...previous, [key]: value }))
  }, [])

  const reset = () => setParams(normalizeParams(DEFAULTS))

  const model = useMemo(() => runModel(params), [params])
  const { dataPoints, events, summary, warnings } = model
  const chartData = useMemo(() => sampleChartData(dataPoints, params.years), [dataPoints, params.years])
  const currency = params.currency
  const f = useCallback((value) => fmt(value, currency), [currency])

  useEffect(() => {
    const url = paramsToURL(params)
    window.history.replaceState(null, '', url)
  }, [params])

  useEffect(() => {
    localStorage.setItem('nav-calculator-theme', dark ? 'dark' : 'light')
    document.documentElement.style.background = dark ? '#080b12' : '#f6f7fb'
    document.body.style.background = dark ? '#080b12' : '#f6f7fb'
  }, [dark])

  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href)
  }

  const resultName = STRATEGY_COPY[params.strategy].resultLabel
  const strategyWins = summary.winner === 'strategy'
  const strategyNote = params.strategy === 'distribution'
    ? 'Cash is created only by real fund distributions. The NAV is reduced when the distribution is paid.'
    : params.strategy === 'profit_take'
      ? 'Cash is created by selling units. This means unit count falls instead of magically staying unchanged.'
      : 'New units are created by new outside contributions. Use the annualized cashflow return and total contributed amount, not just final value.'
  const comparisonTitle = params.strategy === 'contribution'
    ? 'Contribution mode is not a direct winner comparison'
    : `${strategyWins ? STRATEGY_COPY[params.strategy].title : 'Buy & Hold'} has the higher net gain`
  const comparisonBody = params.strategy === 'contribution'
    ? `The strategy has ${f(summary.strategyFinal)} after total contributions of ${f(summary.totalInvested)}, while Buy & Hold has ${f(summary.holdFinal)} from the initial investment only. ${strategyNote}`
    : `by ${f(summary.margin)}. ${strategyNote}`

  return (
    <div className={`app ${dark ? 'dark' : 'light'}`}>
      <header className="header">
        <div className="header-inner">
          <div>
            <h1 className="title">NAV Strategy Calculator</h1>
            <p className="subtitle">Realistic unit-based mutual fund simulator — no double-counted “profit cash.”</p>
          </div>
          <div className="header-actions">
            <span className="badge">Effective growth: {pct(summary.effectiveAnnualGrowthPct)}/yr</span>
            <button className="button-secondary" onClick={() => setDark((value) => !value)}>
              {dark ? 'Light mode' : 'Dark mode'}
            </button>
            <button className="button-secondary" onClick={copyLink}>Copy link</button>
            <button className="button-ghost" onClick={reset}>Reset</button>
          </div>
        </div>
      </header>

      <main className="app-shell layout">
        <aside className="stack">
          <section className="panel">
            <p className="section-label">Strategy mode</p>
            <div className="strategy-grid">
              {Object.entries(STRATEGY_COPY).map(([key, copy]) => (
                <button
                  type="button"
                  key={key}
                  className={`strategy-card ${params.strategy === key ? 'active' : ''}`}
                  onClick={() => updateParam('strategy', key)}
                >
                  <strong>{copy.title}</strong>
                  <span>{copy.short}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <p className="section-label">Main inputs</p>
            <div className="input-stack">
              <SelectField
                label="Display currency"
                value={params.currency}
                onChange={(value) => updateParam('currency', value)}
                help="Display only. This does not convert exchange rates."
              >
                {['PKR', 'USD', 'GBP', 'EUR', 'AED'].map((currencyOption) => (
                  <option key={currencyOption} value={currencyOption}>{currencyOption}</option>
                ))}
              </SelectField>

              <NumberField
                label="Initial investment"
                value={params.investment}
                min={1}
                step={1000}
                onChange={(value) => updateParam('investment', value)}
                help="Money used to buy the starting units."
              />

              <NumberField
                label="Current NAV per unit"
                value={params.navPerUnit}
                min={0.0001}
                step={0.01}
                onChange={(value) => updateParam('navPerUnit', value)}
                help={`Starting units = investment ÷ NAV = ${(params.investment / params.navPerUnit).toLocaleString(undefined, { maximumFractionDigits: 2 })} units.`}
              />

              <NavFetch onFetched={(value) => updateParam('navPerUnit', value)} />

              <Slider
                label="Annual return before fee"
                value={params.annualGrowth}
                min={-30}
                max={60}
                step={0.25}
                display={(value) => pct(value)}
                onChange={(value) => updateParam('annualGrowth', value)}
                help="This grows NAV before subtracting the management fee and before any distribution NAV drop. If your input is already total return, do not also add a high distribution yield."
              />

              <Slider
                label="Time horizon"
                value={params.years}
                min={1}
                max={30}
                step={1}
                display={(value) => `${value} year${value === 1 ? '' : 's'}`}
                onChange={(value) => updateParam('years', value)}
              />
            </div>
          </section>

          <section className="panel">
            <div className="row-actions" style={{ justifyContent: 'space-between' }}>
              <p className="section-label" style={{ margin: 0 }}>Strategy settings</p>
              <button className="button-ghost" onClick={() => setShowAdvanced((value) => !value)}>
                {showAdvanced ? 'Hide' : 'Show'} advanced
              </button>
            </div>

            <div className="input-stack" style={{ marginTop: 14 }}>
              {params.strategy !== 'contribution' ? (
                <Slider
                  label={params.strategy === 'distribution' ? 'Event frequency' : 'Profit-sale frequency'}
                  value={params.intervalMonths}
                  min={1}
                  max={24}
                  step={1}
                  display={(value) => `Every ${value}m`}
                  onChange={(value) => updateParam('intervalMonths', value)}
                />
              ) : null}

              {params.strategy === 'distribution' ? (
                <>
                  <Slider
                    label="Annual distribution yield"
                    value={params.distributionYield}
                    min={0}
                    max={25}
                    step={0.25}
                    display={(value) => pct(value)}
                    onChange={(value) => updateParam('distributionYield', value)}
                    help="Cash distribution paid by the fund. The model reduces NAV by the distribution amount, which avoids double-counting."
                  />
                  <Slider
                    label="Distribution % to reinvest"
                    value={params.reinvestPct}
                    min={0}
                    max={100}
                    step={5}
                    display={(value) => pct(value)}
                    onChange={(value) => updateParam('reinvestPct', value)}
                    help="The remaining after-tax distribution is kept as cash."
                  />
                </>
              ) : null}

              {params.strategy === 'profit_take' ? (
                <Slider
                  label="Profit to sell/take"
                  value={params.profitTakePct}
                  min={0}
                  max={100}
                  step={5}
                  display={(value) => pct(value)}
                  onChange={(value) => updateParam('profitTakePct', value)}
                  help="At each event, this percentage of unrealized profit is realized by selling units."
                />
              ) : null}

              {params.strategy === 'contribution' ? (
                <>
                  <NumberField
                    label="Recurring contribution"
                    value={params.contributionAmount}
                    min={0}
                    step={1000}
                    onChange={(value) => updateParam('contributionAmount', value)}
                    help="Outside money added to the strategy account."
                  />
                  <Slider
                    label="Contribution frequency"
                    value={params.contributionFrequencyMonths}
                    min={1}
                    max={24}
                    step={1}
                    display={(value) => `Every ${value}m`}
                    onChange={(value) => updateParam('contributionFrequencyMonths', value)}
                  />
                </>
              ) : null}

              {showAdvanced ? (
                <>
                  <Slider
                    label="Tax rate"
                    value={params.taxRate}
                    min={0}
                    max={40}
                    step={0.5}
                    display={(value) => pct(value)}
                    onChange={(value) => updateParam('taxRate', value)}
                    help={params.strategy === 'profit_take'
                      ? 'Applied only to the gain portion of sold units.'
                      : 'Applied to cash distributions before reinvestment or withdrawal.'}
                  />
                  <Slider
                    label="Annual management fee"
                    value={params.managementFee}
                    min={0}
                    max={5}
                    step={0.05}
                    display={(value) => pct(value)}
                    onChange={(value) => updateParam('managementFee', value)}
                    help="Subtracted from annual return for both Buy & Hold and the selected strategy."
                  />
                </>
              ) : null}
            </div>
          </section>
        </aside>

        <section className="stack">
          <section className="panel">
            <p className="section-label">Results after {params.years} year{params.years === 1 ? '' : 's'}</p>
            <div className="results-grid">
              <Metric
                tone="blue"
                label="Buy & Hold total"
                value={f(summary.holdFinal)}
                sub={`Net gain ${f(summary.holdNetGain)} · Ending wealth return ${pct(summary.holdReturn)} · Annualized cashflow return ${pct(summary.holdAnnualizedReturn)}`}
              />
              <Metric
                tone="green"
                label={`${resultName} total`}
                value={f(summary.strategyFinal)}
                sub={`Net gain ${f(summary.strategyNetGain)} · Ending wealth return on contributed ${pct(summary.strategyReturn)} · Annualized cashflow return ${pct(summary.strategyAnnualizedReturn)}`}
              />
              <Metric
                label="Buy & Hold units"
                value={summary.holdUnits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                sub={`Portfolio ${f(summary.holdPortfolio)}${summary.holdCash > 0 ? ` + cash ${f(summary.holdCash)}` : ''}`}
              />
              <Metric
                label="Strategy units"
                value={summary.strategyUnits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                sub={`Portfolio ${f(summary.strategyPortfolio)}${summary.strategyCash > 0 ? ` + cash ${f(summary.strategyCash)}` : ''}`}
              />
              <Metric
                tone="amber"
                label="Total contributed to strategy"
                value={f(summary.totalInvested)}
                sub={summary.extraInvested > 0 ? `Extra money added: ${f(summary.extraInvested)}` : 'No outside money added.'}
              />
              <Metric
                label="Final NAV per unit"
                value={`${currency} ${summary.finalNAV.toLocaleString(undefined, { maximumFractionDigits: 3 })}`}
                sub={`Monthly NAV growth before distributions: ${pct(summary.monthlyGrowthPct)} · Events: ${summary.eventsCount}`}
              />
            </div>

            <div className={`banner ${params.strategy === 'contribution' ? 'warn' : strategyWins ? 'good' : 'blue'}`} style={{ marginTop: 12 }}>
              <strong>{comparisonTitle}</strong>
              {' '}{comparisonBody}
            </div>

            {warnings.map((warning) => (
              <div className="banner warn" key={warning} style={{ marginTop: 10 }}>{warning}</div>
            ))}
          </section>

          <section className="panel">
            <div className="row-actions" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
              <p className="section-label" style={{ margin: 0 }}>Portfolio value over time</p>
              <span className="badge">Chart samples monthly/quarterly for readability</span>
            </div>
            <div className="chart-wrap">
              <SimpleChart data={chartData} currency={currency} />
            </div>
          </section>

          <section className="panel">
            <div className="row-actions" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
              <p className="section-label" style={{ margin: 0 }}>Strategy event log — {events.length} events</p>
              <button className="button-secondary" onClick={() => setShowTable((value) => !value)}>
                {showTable ? 'Hide table' : 'Show table'}
              </button>
            </div>
            {showTable ? <EventTable events={events} currency={currency} strategy={params.strategy} /> : (
              <div className="banner blue">Table hidden. Open it to audit exactly where cash, tax, sold units, and new units came from.</div>
            )}
          </section>

          <section className="panel">
            <p className="section-label">What changed / why this is safer</p>
            <div className="info-grid">
              <div className="info-box">
                <strong>No fake reinvestment</strong>
                <p>The old app reinvested unrealized NAV gains. This version only buys units from distributions, unit sales, or new outside contributions.</p>
              </div>
              <div className="info-box">
                <strong>Cash has a source</strong>
                <p>Withdrawn cash now comes from an actual distribution or a sale of units. Selling units reduces unit count and cost basis.</p>
              </div>
              <div className="info-box">
                <strong>Cleaner UI</strong>
                <p>The dark-mode white border issue is fixed with global body/root background styles, CSS variables, and no default browser margin.</p>
              </div>
            </div>
          </section>
        </section>
      </main>
    </div>
  )
}
