# NAV Strategy Calculator

A realistic unit-based mutual fund/NAV strategy simulator built with React and Vite.

This version intentionally avoids the old flawed logic where unrealized NAV gains were treated as free cash. New units can only come from:

1. real fund distributions/dividends,
2. selling units to take profit,
3. new outside recurring contributions.

## Deploying to Vercel

This project is configured to avoid the Vercel/npm crash you saw:

- no `package-lock.json` is included,
- `.npmrc` disables package-lock creation for this project,
- `vercel.json` overrides the install command to `npm install --no-package-lock --no-audit --no-fund`,
- Node is pinned to `20.x` in `package.json`,
- dependency tree is intentionally small: React + ReactDOM + Vite only,
- the chart is custom SVG, so there is no Recharts dependency.

If you are replacing an older repo, remove the old lock file before pushing:

```bash
git rm package-lock.json
```

If Git says it is not tracked, that is fine. Also make sure `node_modules` and `dist` are not committed.

## Local commands

```bash
npm install --no-package-lock --no-audit --no-fund
npm test
npm run build
npm run dev
```

## Strategy modes

### 1. Distribution reinvestment

The fund pays a cash distribution. The model reduces NAV by the distribution amount, applies tax to the cash distribution, and reinvests the selected percentage into new units.

### 2. Sell units to take profit

Cash comes from selling units. The model reduces unit count and cost basis. Tax is applied only to the gain portion of the sold units.

### 3. Recurring new investment

New units are bought with new outside contributions. The app tracks total contributed money separately and warns that this is not an apples-to-apples final-value comparison against Buy & Hold.

## Model sanity checks

Run:

```bash
npm test
```

The tests verify that:

- zero distributions behave like Buy & Hold,
- full distribution reinvestment with no tax preserves total wealth,
- profit-taking reduces units,
- recurring contributions track extra invested money separately,
- bad URL/query inputs normalize instead of producing `NaN` or `Infinity`,
- randomized inputs keep NAV, units, cash, and totals finite and non-negative.
