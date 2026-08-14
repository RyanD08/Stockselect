/**
 * UI controller: survey flow + results rendering.
 * All state lives in memory only — nothing is persisted between visits.
 */

const state = {
  view: 'intro', // 'intro' | 'survey' | 'review' | 'results'
  categoryIndex: 0,
  furthestCategoryIndex: 0, // highest category index reached in the normal forward flow — governs which chips are jumpable
  editOrigin: null, // null | 'review' — set while editing a category reached via the Review screen or the results "Edit My Answers" control
  answers: {},
  homeCountry: 'United States',
  tiesSector: '',
  dataset: null,
  datasetError: null,
};

QUESTIONS.forEach((q) => {
  state.answers[q.id] = 3; // neutral default
});

const appEl = document.getElementById('app');

function render() {
  if (state.view === 'intro') renderIntro();
  else if (state.view === 'survey') renderSurvey();
  else if (state.view === 'review') renderReview();
  else if (state.view === 'results') renderResults();
}

function renderIntro() {
  appEl.innerHTML = `
    <section class="card intro-card">
      <h1>Values-Based Portfolio Builder</h1>
      <p class="lede">
        Answer a short questionnaire about what matters to you as an investor —
        environmental impact, labor practices, governance, ethical screens,
        community ties, and risk philosophy — and we'll build an illustrative,
        equally-weighted portfolio from our sample company dataset that
        reflects your priorities.
      </p>
      <p class="lede">This takes about 3-5 minutes. Nothing you enter is saved or sent anywhere.</p>
      <button id="start-btn" class="btn btn-primary" ${state.dataset ? '' : 'disabled'}>
        ${state.dataset ? 'Start the Questionnaire' : 'Loading data...'}
      </button>
      ${state.datasetError ? `<p class="error-text">Could not load company data: ${escapeHtml(state.datasetError)}</p>` : ''}
    </section>
  `;
  const startBtn = document.getElementById('start-btn');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      state.view = 'survey';
      state.categoryIndex = 0;
      state.furthestCategoryIndex = 0;
      state.editOrigin = null;
      render();
    });
  }
}

function renderSurvey() {
  const category = CATEGORIES[state.categoryIndex];
  const questions = questionsForCategory(category.key);
  const isLast = state.categoryIndex === CATEGORIES.length - 1;
  const isEditing = state.editOrigin === 'review';

  appEl.innerHTML = `
    <section class="card survey-card">
      <div class="category-chips">
        ${CATEGORIES.map((cat, i) => renderCategoryChip(cat, i)).join('')}
      </div>
      <p class="step-label">Step ${state.categoryIndex + 1} of ${CATEGORIES.length}</p>
      <h2>${escapeHtml(category.label)}</h2>
      <p class="scale-hint">For each item, rate how important it is to you: 1 = not important, 5 = very important.</p>
      <div class="questions-list">
        ${questions.map(renderQuestionRow).join('')}
      </div>
      <div class="nav-row">
        ${
          isEditing
            ? '<button id="back-to-review-btn" class="btn btn-primary">Back to Review</button>'
            : `
              <button id="back-btn" class="btn btn-secondary" ${state.categoryIndex === 0 ? 'disabled' : ''}>Back</button>
              <button id="next-btn" class="btn btn-primary">${isLast ? 'Review My Answers' : 'Next'}</button>
            `
        }
      </div>
    </section>
  `;

  questions.forEach((q) => {
    document.querySelectorAll(`.scale-btn[data-question="${q.id}"]`).forEach((btn) => {
      btn.addEventListener('click', () => {
        state.answers[q.id] = Number(btn.dataset.value);
        document
          .querySelectorAll(`.scale-btn[data-question="${q.id}"]`)
          .forEach((b) => b.classList.toggle('selected', b === btn));
      });
    });
  });

  const homeCountryInput = document.getElementById('home-country-input');
  if (homeCountryInput) {
    homeCountryInput.addEventListener('input', () => {
      state.homeCountry = homeCountryInput.value.trim() || 'United States';
    });
  }

  const tiesSectorSelect = document.getElementById('ties-sector-select');
  if (tiesSectorSelect) {
    tiesSectorSelect.addEventListener('change', () => {
      state.tiesSector = tiesSectorSelect.value;
    });
  }

  document.querySelectorAll('.category-chip').forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => {
      state.categoryIndex = Number(btn.dataset.index);
      render();
    });
  });

  if (isEditing) {
    document.getElementById('back-to-review-btn').addEventListener('click', () => {
      state.editOrigin = null;
      state.view = 'review';
      render();
    });
  } else {
    document.getElementById('back-btn').addEventListener('click', () => {
      if (state.categoryIndex > 0) {
        state.categoryIndex -= 1;
        render();
      }
    });

    document.getElementById('next-btn').addEventListener('click', () => {
      if (isLast) {
        state.furthestCategoryIndex = CATEGORIES.length - 1;
        state.view = 'review';
      } else {
        state.categoryIndex += 1;
        state.furthestCategoryIndex = Math.max(state.furthestCategoryIndex, state.categoryIndex);
      }
      render();
    });
  }
}

// A previously-seen category is jumpable at any time (in normal flow or
// while editing from Review); a category not yet reached in the forward
// flow is shown but disabled, since its answers haven't been presented yet.
function renderCategoryChip(category, index) {
  const isJumpable = index <= state.furthestCategoryIndex;
  const classes = ['category-chip'];
  if (index === state.categoryIndex) classes.push('active');
  if (isJumpable) classes.push('visited');
  return `
    <button type="button" class="${classes.join(' ')}" data-index="${index}" ${isJumpable ? '' : 'disabled'}>
      ${index + 1}. ${escapeHtml(category.label)}
    </button>
  `;
}

function renderQuestionRow(q) {
  const current = state.answers[q.id];
  return `
    <div class="question-row">
      <p class="question-text">${escapeHtml(q.text)}</p>
      <div class="scale">
        ${[1, 2, 3, 4, 5]
          .map(
            (v) => `
          <button type="button" class="scale-btn ${v === current ? 'selected' : ''}" data-question="${q.id}" data-value="${v}">${v}</button>
        `
          )
          .join('')}
      </div>
      <div class="scale-labels"><span>Not important</span><span>Very important</span></div>
      ${q.needsHomeCountry ? renderHomeCountryInput() : ''}
      ${q.needsTiesSector ? renderTiesSectorSelect() : ''}
    </div>
  `;
}

function renderHomeCountryInput() {
  return `
    <div class="sub-input">
      <label for="home-country-input">Your home country (for the domestic-company match)</label>
      <input id="home-country-input" type="text" value="${escapeHtml(state.homeCountry)}" />
    </div>
  `;
}

function renderTiesSectorSelect() {
  return `
    <div class="sub-input">
      <label for="ties-sector-select">Sector you have personal/professional ties to (optional)</label>
      <select id="ties-sector-select">
        <option value="">None / prefer not to say</option>
        ${SECTOR_OPTIONS.map(
          (s) => `<option value="${escapeHtml(s)}" ${state.tiesSector === s ? 'selected' : ''}>${escapeHtml(s)}</option>`
        ).join('')}
      </select>
    </div>
  `;
}

function renderReview() {
  appEl.innerHTML = `
    <section class="card review-card">
      <h1>Review Your Answers</h1>
      <p class="lede">Check everything below and use Edit to revise anything before we build your portfolio.</p>
      ${CATEGORIES.map((category, i) => renderReviewCategory(category, i)).join('')}
      <div class="nav-row">
        <button id="review-submit-btn" class="btn btn-primary">See My Portfolio</button>
      </div>
    </section>
  `;

  document.querySelectorAll('.review-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.categoryIndex = Number(btn.dataset.categoryIndex);
      state.editOrigin = 'review';
      state.view = 'survey';
      render();
    });
  });

  document.getElementById('review-submit-btn').addEventListener('click', () => {
    state.view = 'results';
    render();
  });
}

function renderReviewCategory(category, categoryIndex) {
  const questions = questionsForCategory(category.key);
  const isCommunity = category.key === 'community';
  return `
    <div class="review-category">
      <div class="review-category-header">
        <h3>${escapeHtml(category.label)}</h3>
        <button type="button" class="review-edit-btn" data-category-index="${categoryIndex}">Edit</button>
      </div>
      <ul class="review-answer-list">
        ${questions
          .map(
            (q) => `
          <li><span class="review-q-text">${escapeHtml(q.text)}</span><span class="review-q-answer">${state.answers[q.id]}/5</span></li>
        `
          )
          .join('')}
        ${
          isCommunity
            ? `
          <li><span class="review-q-text">Home country</span><span class="review-q-answer">${escapeHtml(state.homeCountry)}</span></li>
          <li><span class="review-q-text">Industry ties</span><span class="review-q-answer">${state.tiesSector ? escapeHtml(state.tiesSector) : 'None'}</span></li>
        `
            : ''
        }
      </ul>
    </div>
  `;
}

function renderResults() {
  const { riskProfile, holdings } = buildPortfolio(state.dataset, state.answers, {
    homeCountry: state.homeCountry,
    tiesSector: state.tiesSector,
  });
  const topPriorities = QUESTIONS.filter((q) => q.id <= 20 && state.answers[q.id] === 5);

  appEl.innerHTML = `
    <section class="card results-card">
      <h1>Your Values-Based Portfolio</h1>

      <div class="summary-grid">
        <div class="summary-box">
          <h3>Your Top Priorities</h3>
          ${
            topPriorities.length > 0
              ? `<ul class="priority-list">${topPriorities.map((q) => `<li>${escapeHtml(q.short)}</li>`).join('')}</ul>`
              : '<p class="muted">You rated no single criterion as a 5 out of 5 — your priorities are more evenly balanced.</p>'
          }
        </div>
        <div class="summary-box">
          <h3>Your Risk Profile</h3>
          <p class="risk-badge risk-${riskProfile.toLowerCase()}">${riskProfile}</p>
          <p class="muted">${riskProfileBlurb(riskProfile)}</p>
        </div>
      </div>

      <h2>Recommended Holdings</h2>
      <p class="muted">
        ${holdings.length} companies, equally weighted at ${holdings.length > 0 ? (100 / holdings.length).toFixed(2) : '0'}% each.
        No more than 3 holdings are drawn from any single sector. Strong Matches are always listed ahead of Partial
        Matches. Domestic-company match is based on headquarters in <strong>${escapeHtml(state.homeCountry)}</strong>.
      </p>
      <div class="table-wrap">
        <table class="results-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Company</th>
              <th>Sector</th>
              <th>Allocation</th>
              <th>Match Tier</th>
              <th>Rationale</th>
            </tr>
          </thead>
          <tbody>
            ${holdings.map(renderHoldingRow).join('')}
          </tbody>
        </table>
      </div>

      <h2>Portfolio Rationale</h2>
      <div class="rationale">
        ${buildPortfolioRationale(state.answers, riskProfile, holdings)
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join('')}
      </div>

      <div class="disclaimer">
        <strong>Important disclaimer:</strong> This tool is illustrative and educational only. It is built on a
        limited, 100-company sample dataset with estimated — not independently verified — values and performance
        data for many criteria (labor practices, governance details, financial leverage, market-cap tier, beta,
        five-year returns, and revenue geography in particular rely on rough, illustrative estimates rather than a
        live market-data feed). It is not licensed financial advice, and the results should not be relied upon for
        actual investment decisions. Please consult a registered financial advisor before making any investment
        decisions.
      </div>

      <div class="nav-row">
        <button id="edit-answers-btn" class="btn btn-secondary">Edit My Answers</button>
        <button id="restart-btn" class="btn btn-secondary">Start Over</button>
      </div>
    </section>
  `;

  document.getElementById('edit-answers-btn').addEventListener('click', () => {
    state.editOrigin = null;
    state.view = 'review';
    render();
  });

  document.getElementById('restart-btn').addEventListener('click', () => {
    QUESTIONS.forEach((q) => {
      state.answers[q.id] = 3;
    });
    state.homeCountry = 'United States';
    state.tiesSector = '';
    state.categoryIndex = 0;
    state.furthestCategoryIndex = 0;
    state.editOrigin = null;
    state.view = 'intro';
    render();
  });
}

function renderHoldingRow(entry) {
  const tierClass = entry.tier === 'Strong' ? 'tier-strong' : 'tier-partial';
  return `
    <tr>
      <td>${escapeHtml(entry.company.ticker)}</td>
      <td>${escapeHtml(entry.company.name)}</td>
      <td>${escapeHtml(entry.company.sector)}</td>
      <td>${entry.allocationPct.toFixed(2)}%</td>
      <td><span class="tier-badge ${tierClass}">${entry.tier} Match</span></td>
      <td>
        <div>${escapeHtml(entry.rationale)}</div>
        ${entry.note ? `<div class="partial-note">${escapeHtml(entry.note)}</div>` : ''}
      </td>
    </tr>
  `;
}

function riskProfileBlurb(riskProfile) {
  if (riskProfile === 'Conservative') {
    return 'You favor long-term stability, blue-chip/dividend-paying companies, and are less willing to trade returns for values alignment. We weighted ties toward lower-beta, larger-cap, higher-stability holdings.';
  }
  if (riskProfile === 'Growth') {
    return 'You favor growth potential and smaller/emerging companies, and are more willing to accept lower stability in pursuit of values alignment. We weighted ties toward higher-return, higher-beta, growth-oriented holdings.';
  }
  return 'You are comfortable balancing stability and growth potential. We weighted ties toward holdings with the best risk-adjusted profile (five-year return relative to beta).';
}

function buildPortfolioRationale(answers, riskProfile, holdings) {
  const topPriorities = QUESTIONS.filter((q) => q.id <= 20 && answers[q.id] === 5).map((q) => q.short);
  const strongCount = holdings.filter((h) => h.tier === 'Strong').length;
  const partialCount = holdings.length - strongCount;

  const priorityPhrase =
    topPriorities.length > 0
      ? `your strongest stated priorities — ${topPriorities.join(', ')} — `
      : 'the balanced set of priorities you expressed across the questionnaire ';

  const p1 =
    `Based on your responses, we've built a ${holdings.length}-holding portfolio weighted around ${priorityPhrase}` +
    `alongside a ${riskProfile.toLowerCase()} risk profile derived from your stability, blue-chip, and dividend ` +
    `preferences. Each company in our sample dataset was scored on how well it aligns with your specific answers, ` +
    `distinguishing criteria you asked us to screen out (like sin-stock exposure or high leverage) from criteria ` +
    `you asked us to seek out (like renewable-energy focus or domestic revenue) — rather than applying hard ` +
    `exclusions, so the portfolio reflects the full spectrum of available companies ranked by fit.`;

  const p2 =
    `Strong Matches are always listed ahead of Partial Matches: ${strongCount} of the ${holdings.length} holdings ` +
    `are Strong Matches, meaning none of the criteria you rated as a top priority (a 4 or 5 out of 5) produced a ` +
    `meaningful conflict. ${
      partialCount > 0
        ? `The remaining ${partialCount} are Partial Matches — generally well-aligned with your values overall, but ` +
          `each carries a specific trade-off against one of your top priorities, which we've called out individually ` +
          `in the table above so you can decide whether that trade-off is acceptable to you.`
        : `No holdings required a trade-off against your top priorities.`
    } Where companies were closely tied on fit, we broke ties using your derived risk profile and quantitative ` +
    `data (beta, market-cap tier, and estimated five-year returns). Positions are equally weighted, and we capped ` +
    `exposure to any single sector at three holdings to keep the portfolio reasonably diversified.`;

  const p3 =
    `As always, values-based investing involves judgment calls, and the data underlying some of these criteria — ` +
    `particularly labor practices, governance details, financial leverage, and the market/performance estimates ` +
    `used for tie-breaking — is illustrative rather than pulled from a live, licensed data feed. We'd encourage ` +
    `you to treat this as a starting point for a conversation, not a finished recommendation.`;

  return [p1, p2, p3];
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function init() {
  render();
  try {
    state.dataset = await loadDataset();
  } catch (err) {
    state.datasetError = err.message;
  }
  if (state.view === 'intro') render();
}

init();
