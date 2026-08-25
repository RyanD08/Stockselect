/**
 * Learn: short lessons + quizzes on the values-investing concepts behind
 * TrueNorth's own scoring (CEO pay ratios, sin-stock screens, sector
 * diversification, etc.). Login-gated the same way as My Portfolios/My
 * Watchlist/Compare Two Companies (see navigateToLearn, app.js) -- a
 * logged-out click redirects to login and lands back here automatically
 * once signed in (see pendingLearnRedirect below and its handling in
 * auth.js's onAuthStateChanged).
 *
 * Self-contained: reuses auth.js's Firebase plumbing (firebaseReady,
 * firebaseDb, authState) but never reads or writes survey/scoring/Ticker
 * Tester/Watchlist state. Progress lives in its own Firestore subcollection
 * (users/{uid}/learnProgress/{lessonId} -- see firestore.rules) and is also
 * wiped by deleteAccount's ALL_USER_SUBCOLLECTIONS list (auth.js).
 *
 * Completion is attempt-gated, not score-gated, per design: submitting the
 * quiz once marks the lesson complete regardless of score, and a later
 * retry can only raise the recorded best score, never revoke completion --
 * see recordLessonCompletion below. Nothing here blocks or requires
 * finishing a lesson to use the rest of the site.
 */

const LESSONS = [
  {
    id: 'ceo-pay-ratio',
    title: 'What is a CEO Pay Ratio?',
    description: 'How CEO pay is compared to a typical employee’s, and why some investors track it.',
    body: [
      'Since 2018, U.S. public companies have been required to disclose something called the "CEO pay ratio": how much the CEO is paid in total compensation (salary, bonus, stock awards, and other benefits) compared to the company’s own median employee’s total compensation. The ratio is calculated simply as CEO pay divided by median employee pay.',
      'For example, imagine a retailer where the CEO’s total compensation for the year comes to $12,000,000, and the median employee at that company earns $50,000. Dividing those two numbers gives a ratio of 240-to-1 -- meaning the CEO was paid about 240 times what a typical employee at the same company earned that year.',
      'Some investors treat a very high ratio as a governance red flag: it can suggest pay decisions are disconnected from how the rest of the workforce is compensated, or that a board isn’t exercising much restraint on executive pay. Other investors see it as a much less meaningful number on its own -- a large, capital-intensive company with a big base of lower-wage frontline workers will naturally show a higher ratio than a smaller company with a more uniformly paid workforce, even if both boards are equally reasonable about executive pay. Company size, industry, and workforce composition all move this number a lot, which is exactly why it’s usually treated as one data point among several rather than a verdict on its own.',
      'TrueNorth uses this same idea as one of its governance questions -- "reasonable executive compensation relative to average employee pay" -- and treats it as one signal that can be weighted up or down depending on how much a client says it matters to them, not as an automatic disqualifier.',
    ],
    quiz: [
      {
        type: 'mc',
        question: 'A company reports total CEO compensation of $9,000,000 and median employee compensation of $60,000. What is the approximate CEO pay ratio?',
        options: ['15-to-1', '90-to-1', '150-to-1', '600-to-1'],
        correctIndex: 2,
      },
      {
        type: 'tf',
        question: 'True or false: the CEO pay ratio is calculated using the CEO’s salary alone, not their total compensation.',
        options: ['True', 'False'],
        correctIndex: 1,
      },
      {
        type: 'mc',
        question: 'Two companies both have a CEO pay ratio around 300-to-1: a large industrial company with tens of thousands of frontline hourly workers, and a small, all-salaried software company. What does this tell you on its own?',
        options: [
          'Both companies have equally excessive executive pay',
          'The ratio alone isn’t enough to compare them fairly -- company size and workforce makeup affect the number a lot',
          'The software company’s ratio is more concerning, since it has fewer employees',
          'The ratio can only be calculated for companies with over 10,000 employees',
        ],
        correctIndex: 1,
      },
      {
        type: 'tf',
        question: 'True or false: TrueNorth treats a high CEO pay ratio as an automatic disqualifier that removes a company from every client’s results.',
        options: ['True', 'False'],
        correctIndex: 1,
      },
    ],
  },
  {
    id: 'sin-stocks',
    title: 'What Counts as a "Sin Stock"?',
    description: 'The industries some investors choose to screen out, and why others don’t.',
    body: [
      '"Sin stocks" is a long-standing informal term for companies in a handful of industries that some investors have traditionally chosen to avoid on ethical or values grounds. The categories are pretty consistent across most values-based screening tools: tobacco, alcohol, gambling/casinos, and weapons/defense manufacturing. Some screens also include adult entertainment and interest-based ("usury") financial products, which matter in particular to investors following certain religious or ethical traditions that prohibit interest-based finance.',
      'The reasoning for avoiding these industries varies by investor. Someone might avoid tobacco companies because of the direct, well-documented health harms of the product. Someone else might avoid weapons manufacturers on the belief that profiting from arms production conflicts with their personal values, regardless of whether the company operates legally and profitably. A third investor might avoid gambling companies specifically because of concerns about addiction and its effects on vulnerable communities.',
      'It’s worth being clear that none of this is about whether these companies are well-run or profitable -- many sin-stock companies are large, stable, and financially strong businesses. Historically, some of them have even been noted for steady dividends and defensive performance during downturns (people tend to keep buying alcohol and tobacco products even in a recession). The screen is entirely about whether an investor personally wants their money associated with that industry, not a judgment about the business itself.',
      'It also cuts both ways: plenty of investors deliberately choose NOT to screen these out, either because they don’t hold the same personal objections, or because they specifically want the stability or dividend characteristics these industries can offer. TrueNorth presents each of these as its own separate, optional screening question -- tobacco, alcohol, gambling, weapons, adult entertainment, and interest-based products are each rated independently, so a client can screen out exactly the categories that matter to them and leave the rest untouched.',
    ],
    quiz: [
      {
        type: 'mc',
        question: 'Which of these is NOT one of the traditional "sin stock" screening categories?',
        options: ['Tobacco', 'Weapons/defense manufacturing', 'Renewable energy', 'Gambling/casinos'],
        correctIndex: 2,
      },
      {
        type: 'tf',
        question: 'True or false: a company being classified in a "sin stock" category means the company is poorly run or financially unstable.',
        options: ['True', 'False'],
        correctIndex: 1,
      },
      {
        type: 'mc',
        question: 'Two clients use TrueNorth. Client A rates "avoiding gambling/casinos" a 5 (strongly avoid) but leaves "avoiding alcohol producers" at the neutral default. Client B does the opposite. What should happen to their results?',
        options: [
          'Both clients get identical results, since sin-stock screens are all-or-nothing',
          'Client A’s results screen out gambling companies but not alcohol producers, and Client B’s do the reverse -- each screen is independent',
          'Neither client’s answers matter, since sin-stock companies are always excluded',
          'Only Client A’s rating is applied, since gambling is considered the more serious category',
        ],
        correctIndex: 1,
      },
      {
        type: 'tf',
        question: 'True or false: every investor who uses values-based screening chooses to avoid all sin-stock categories.',
        options: ['True', 'False'],
        correctIndex: 1,
      },
    ],
  },
  {
    id: 'sbti-climate-targets',
    title: 'Understanding SBTi Climate Targets',
    description: 'What it means for a company’s climate targets to be independently validated, versus self-declared.',
    body: [
      'When a company says it’s committed to reducing its carbon emissions, that claim can mean very different things depending on who checked it. The Science Based Targets initiative (SBTi) is an independent body -- a partnership between several environmental and climate organizations -- that reviews a company’s proposed emissions-reduction targets and checks whether they’re actually consistent with what climate science says is needed to limit global warming, generally in line with the goals of the Paris Agreement.',
      'If a company’s target is reviewed and approved, it’s described as "SBTi-validated" or having a "science-based target." That means an outside organization, using a defined methodology, looked at the specific numbers -- how much the company plans to cut emissions, and by when -- and confirmed the target is ambitious enough to be scientifically credible, not just a vague, feel-good promise with no real teeth.',
      'This matters because plenty of companies make climate claims without any outside check at all. A company might announce it’s "committed to sustainability" or aiming for "net zero" with no specific, verifiable numbers behind it, and no independent party confirming those numbers add up. That gap -- between a genuinely validated target and an unverified marketing claim -- is often exactly what critics mean when they use the term "greenwashing": presenting a company as more environmentally responsible than an independent look at the actual numbers would support.',
      'None of this means an unvalidated climate claim is automatically false, or that a validated target guarantees a company will actually hit it -- validation checks the target itself, not whether the company follows through. But it does give an investor a genuine, independently-checked signal to look for, rather than having to take a company’s own environmental messaging at face value.',
    ],
    quiz: [
      {
        type: 'mc',
        question: 'What does it mean for a company’s climate target to be "SBTi-validated"?',
        options: [
          'The company invented the target itself with no outside review',
          'An independent body reviewed the specific target and confirmed it’s consistent with what climate science says is needed',
          'The government has legally required the company to hit that target',
          'The company has already achieved net-zero emissions',
        ],
        correctIndex: 1,
      },
      {
        type: 'tf',
        question: 'True or false: a company announcing it is "committed to sustainability," with no specific numbers or outside verification, is the same thing as having an SBTi-validated target.',
        options: ['True', 'False'],
        correctIndex: 1,
      },
      {
        type: 'mc',
        question: 'Company X has an SBTi-validated emissions target for 2030. Which statement is most accurate?',
        options: [
          'Company X is guaranteed to hit that target, since it was validated',
          'The target itself was independently checked for scientific credibility, but whether the company actually follows through is a separate question',
          'Validation means the company has already cut all of its emissions',
          'SBTi validation has nothing to do with climate science',
        ],
        correctIndex: 1,
      },
      {
        type: 'tf',
        question: 'True or false: "greenwashing" refers to a company genuinely exceeding its independently validated climate targets.',
        options: ['True', 'False'],
        correctIndex: 1,
      },
    ],
  },
  {
    id: 'growth-vs-stability',
    title: 'Growth vs. Stability — Why We Never Blend Them',
    description: 'Why TrueNorth keeps a company’s growth potential and its stability as two separate signals instead of one blended score.',
    body: [
      'When people evaluate a company’s financial quality, it’s tempting to boil everything down to one overall number. TrueNorth deliberately resists that for one particular pair of signals: growth potential and stability. These are tracked as two separate tiers (each rated Low, Medium, or High) rather than being averaged together into a single figure, and which one gets weighted more heavily depends entirely on the risk profile a client’s answers point to -- a Conservative profile leans on the stability signal, while a Growth profile leans on the growth signal.',
      'The reason comes down to what a blended number would actually hide. Imagine a real, common scenario: a company completes a major acquisition partway through the year. Its reported year-over-year revenue suddenly jumps by, say, 80% -- not because the underlying business is booming, but simply because it’s now reporting the combined revenue of two companies instead of one. If that distorted growth figure got averaged together with a genuine stability measure into one blended score, the result would quietly overstate how "strong" the company really is, in a way that has nothing to do with its actual investment characteristics.',
      'TrueNorth’s own historical simulation feature runs into exactly this problem with a related figure -- trailing 12-month price return -- and handles it the same way: rather than trying to guess or smooth over a distorted number, a company whose return figure is unreliable because of a recent merger, spin-off, IPO, or ticker change is simply excluded from that calculation rather than having a misleading estimate plugged in. The principle in both cases is the same: a distorted number is worse than no number, so it’s better to keep signals honest and separate than to blend something reliable with something temporarily distorted.',
      'Keeping growth and stability apart also just respects that they answer different questions for different investors. A client who cares about long-term stability isn’t well served by a score where a temporary growth spike (real or accounting-driven) quietly outweighs the steadiness they actually asked for -- and the reverse is just as true for a client chasing growth.',
    ],
    quiz: [
      {
        type: 'mc',
        question: 'A company’s reported revenue jumps 80% year-over-year purely because it completed a large acquisition. What is the risk of blending this growth figure into one overall financial-quality score?',
        options: [
          'There is no risk -- higher revenue always means a stronger score',
          'It could make the company look artificially stronger overall, since the jump reflects an accounting change, not real underlying business momentum',
          'It would only affect the company’s stability tier, not its growth tier',
          'Blended scores automatically correct for mergers',
        ],
        correctIndex: 1,
      },
      {
        type: 'tf',
        question: 'True or false: TrueNorth’s historical simulation feature estimates a reasonable substitute return for a company whose trailing 12-month return is distorted by a recent merger.',
        options: ['True', 'False'],
        correctIndex: 1,
      },
      {
        type: 'mc',
        question: 'Which client is growth potential weighted more heavily for?',
        options: ['A client whose answers point to a Conservative risk profile', 'A client whose answers point to a Growth risk profile', 'Every client equally, regardless of risk profile', 'Only clients who select the short-term time horizon'],
        correctIndex: 1,
      },
      {
        type: 'tf',
        question: 'True or false: the underlying principle behind keeping growth and stability separate is the same one behind excluding a merger-distorted return from the historical simulation -- a distorted number is worse than no number at all.',
        options: ['True', 'False'],
        correctIndex: 0,
      },
    ],
  },
  {
    id: 'data-sourcing',
    title: 'How TrueNorth Sources Its Data',
    description: 'What the High/Medium/Low/None confidence ratings mean, and why a missing data point isn’t treated as a bad score.',
    body: [
      'Every values-related data point TrueNorth uses for a company -- things like environmental record, labor practices, board governance, and political transparency -- comes from real public sources: SEC filings (10-Ks and proxy statements), EPA compliance records, OSHA safety data, FEC political donation records, and FTC records, among others. Financial figures like P/E ratio, revenue growth, and margins come from SEC filings and live market data feeds. Where a specific public source doesn’t exist for a question at this scale, TrueNorth doesn’t guess or estimate -- that question simply isn’t scored for companies without real coverage.',
      'Because "public data" doesn’t mean "equally reliable data," every values data point also carries its own confidence rating: High, Medium, Low, or None. A High-confidence finding is one drawn directly and clearly from a strong primary source. A Medium or Low rating reflects more indirect evidence, an older filing, or a source that leaves more room for interpretation. A rating of "None" means no verifiable public data could be found for that company on that specific question at all.',
      'This confidence rating isn’t just a label -- it actually changes how much weight that data point carries in a client’s results. A well-documented, High-confidence finding counts more than a Low-confidence one of the same nominal value, so a shakier piece of evidence naturally has less influence than a solid one.',
      'It’s especially important to understand what happens when a company has no verifiable data on a question at all (confidence "None"): TrueNorth treats that as neutral, not as a strike against the company. A company isn’t penalized just because good public data happens not to exist for it on one particular question -- that would unfairly punish smaller or less-covered companies for a gap in public reporting rather than anything about their actual conduct.',
    ],
    quiz: [
      {
        type: 'mc',
        question: 'What does a confidence rating of "None" mean for a specific company on a specific question?',
        options: [
          'The company scored the worst possible result on that question',
          'No verifiable public data could be found for that company on that question, so it’s treated as neutral',
          'The question doesn’t apply to that company’s industry',
          'The data was found but is currently under legal dispute',
        ],
        correctIndex: 1,
      },
      {
        type: 'tf',
        question: 'True or false: a High-confidence finding and a Low-confidence finding of the same nominal value carry equal weight in a client’s results.',
        options: ['True', 'False'],
        correctIndex: 1,
      },
      {
        type: 'mc',
        question: 'Why doesn’t TrueNorth estimate or guess a value when no public source exists for a question?',
        options: [
          'Estimating would take too much computing power',
          'To avoid presenting a fabricated number as if it were real, verifiable data',
          'Because every company always has data for every question',
          'Estimates are only avoided for financial data, not values data',
        ],
        correctIndex: 1,
      },
      {
        type: 'tf',
        question: 'True or false: a smaller company with less public reporting coverage is automatically scored worse than a larger, more heavily covered one on questions where its data is missing.',
        options: ['True', 'False'],
        correctIndex: 1,
      },
    ],
  },
  {
    id: 'esg-investing',
    title: 'What is ESG Investing?',
    description: 'A neutral primer on Environmental, Social, and Governance investing -- one approach among several.',
    body: [
      'ESG stands for Environmental, Social, and Governance. It’s a framework some investors use to evaluate companies on factors beyond just traditional financial metrics like revenue or profit margin. "Environmental" covers things like a company’s carbon emissions, pollution record, and resource use. "Social" covers labor practices, workplace safety, and diversity. "Governance" covers how a company is run internally -- board independence, executive pay, and shareholder rights, among other things.',
      'ESG investing grew out of a longer history of "socially responsible investing," which itself traces back decades to investors who wanted to align their portfolios with personal or religious values (some of the earliest examples avoided tobacco, alcohol, and gambling companies -- the same categories covered in TrueNorth’s own "sin stock" lesson). ESG broadened that idea into a more structured, measurable framework that could, in principle, be applied consistently across a huge number of companies.',
      'People approach ESG for different reasons, and it’s worth naming that honestly rather than picking a side. Some investors use it purely for values alignment -- they want their money invested in a way that reflects their personal ethics, independent of whether it affects returns. Others argue certain ESG factors (like governance quality or exposure to regulatory/environmental risk) are also genuinely useful financial signals, not just an ethical add-on. And there’s real, ongoing debate -- among investors, economists, and policymakers -- about how much ESG factors actually predict financial performance, how consistently different data providers score the same company, and whether the whole framework is a meaningful signal or mostly marketing in some cases.',
      'TrueNorth doesn’t take a position in that debate. It treats ESG-style questions the same way it treats every other question on its questionnaire: as one more category a client can weight up, weight down, or leave neutral, based entirely on what actually matters to them.',
    ],
    quiz: [
      {
        type: 'mc',
        question: 'What do the three letters in "ESG" stand for?',
        options: [
          'Ethical, Sustainable, Governance',
          'Environmental, Social, Governance',
          'Equity, Stock, Growth',
          'Environmental, Sustainable, Global',
        ],
        correctIndex: 1,
      },
      {
        type: 'tf',
        question: 'True or false: every investor who considers ESG factors does so purely for values alignment, with no interest in whether those factors relate to financial risk or performance.',
        options: ['True', 'False'],
        correctIndex: 1,
      },
      {
        type: 'mc',
        question: 'Which best describes the current state of debate around ESG investing?',
        options: [
          'There is unanimous agreement that ESG factors always improve financial returns',
          'There is unanimous agreement that ESG factors are purely marketing with no real basis',
          'There is genuine, ongoing debate about how predictive ESG factors are and how consistently they’re measured across providers',
          'The debate was fully settled decades ago before the term "ESG" existed',
        ],
        correctIndex: 2,
      },
      {
        type: 'tf',
        question: 'True or false: "Governance," in the ESG framework, refers to things like board independence and executive pay -- not environmental factors.',
        options: ['True', 'False'],
        correctIndex: 0,
      },
    ],
  },
  {
    id: 'dual-class-shares',
    title: 'Understanding Dual-Class Shares and Shareholder Voting',
    description: 'What it means when not all shares of a company carry the same voting power.',
    body: [
      'When you buy a typical share of stock, you’d usually expect it to come with one vote per share on company matters -- electing the board, approving major decisions, and so on. A "dual-class" (or multi-class) share structure breaks that assumption: the company issues two or more classes of stock, and one class carries far more voting power per share than the other, even though both classes may have similar or identical economic rights (dividends, claim on profits, and so on).',
      'A common real-world pattern looks like this: founders or early insiders hold a class of shares with, say, 10 votes per share, while the shares sold to the public in an IPO carry only 1 vote per share. Because of that gap, the founders can retain majority voting control over the company’s decisions while owning only a small fraction of its total economic value -- sometimes well under half, or even under 10%, depending on how the structure is set up.',
      'Some investors see a real governance concern here: if a small group holds outsized voting control, the board and management face much less accountability to the broader base of public shareholders. A dual-class structure can effectively insulate leadership from a shareholder vote no matter how the rest of the company’s owners feel about a decision. Supporters of dual-class structures argue the opposite case -- that it lets founders pursue a long-term vision without being pressured into short-term decisions by public markets, insulated from activist investors pushing for quick wins.',
      'TrueNorth treats "avoiding companies with concentrated or dual/multi-class voting structures that limit shareholder rights" as its own governance question, exactly like the CEO pay ratio question -- a signal a client can weight according to how much this particular governance structure concerns them, not an automatic exclusion.',
    ],
    quiz: [
      {
        type: 'mc',
        question: 'In a typical dual-class share structure, what usually differs between the two classes of stock?',
        options: [
          'One class pays dividends and the other never does',
          'One class carries far more voting power per share than the other, even with similar economic rights',
          'One class can only be owned by company employees',
          'One class trades on a different stock exchange entirely',
        ],
        correctIndex: 1,
      },
      {
        type: 'tf',
        question: 'True or false: in a dual-class structure, the group holding the high-vote shares always owns a majority of the company’s total economic value.',
        options: ['True', 'False'],
        correctIndex: 1,
      },
      {
        type: 'mc',
        question: 'A founder holds 10-vote-per-share stock representing about 20% of a company’s total shares outstanding, while public 1-vote shares make up the other 80%. Which is most likely true?',
        options: [
          'The founder controls a minority of votes, since they own a minority of shares',
          'Because of the 10x voting weight, the founder likely controls a majority of votes despite owning a minority of shares',
          'Voting power is always proportional to shares owned, regardless of class',
          'Dual-class structures are illegal in the United States',
        ],
        correctIndex: 1,
      },
      {
        type: 'tf',
        question: 'True or false: supporters of dual-class structures argue they can let founders pursue long-term decisions without pressure from short-term-focused investors.',
        options: ['True', 'False'],
        correctIndex: 0,
      },
    ],
  },
  {
    id: 'diversification',
    title: 'What Does It Mean to "Diversify" a Portfolio?',
    description: 'The basic idea behind spreading investments across sectors, and how TrueNorth applies it.',
    body: [
      'Diversification is one of the oldest and most widely accepted ideas in investing: instead of putting all of your money into one company, or one narrow slice of the market, you spread it across a variety of different holdings. The logic is straightforward -- if one company or industry hits a rough patch, a diversified portfolio isn’t nearly as exposed to that single event, because the rest of the portfolio isn’t tied to the same cause.',
      'Diversification can happen along several dimensions at once: across individual companies (not just one stock), across sectors or industries (not just, say, technology companies), across company sizes, and sometimes across asset classes entirely (stocks, bonds, real estate, and so on). The version most relevant to how TrueNorth builds a recommended portfolio is sector diversification -- making sure a portfolio isn’t overly concentrated in any single industry, even if that industry happens to score very well on a client’s particular values priorities.',
      'Here’s why that matters in practice: imagine a client’s values priorities happen to line up unusually well with the technology sector specifically. Without any diversification rule, a portfolio built purely by matching individual company scores could end up being almost entirely technology companies. That portfolio might reflect the client’s values very well, but it would also be unusually exposed to anything that specifically affects that one sector -- a regulatory crackdown, a shift in consumer spending, or a sector-wide downturn would hit the whole portfolio at once.',
      'TrueNorth addresses this directly with a hard cap: no more than 5 companies from the same sector can appear in a single recommended portfolio (out of up to 15 total holdings). This means even a client whose values line up extremely well with one sector will still see a portfolio spread across multiple industries, rather than one that’s accidentally concentrated in a single area just because that area happened to score best.',
    ],
    quiz: [
      {
        type: 'mc',
        question: 'What is the basic idea behind diversification?',
        options: [
          'Putting all of your money into the single highest-scoring company',
          'Spreading investments across different holdings so no single company or sector can hurt the whole portfolio at once',
          'Only ever owning one company per year',
          'Avoiding the stock market entirely in favor of cash',
        ],
        correctIndex: 1,
      },
      {
        type: 'tf',
        question: 'True or false: without a sector diversification rule, a portfolio built purely from individual company scores could end up heavily concentrated in one sector, if that sector happened to score especially well.',
        options: ['True', 'False'],
        correctIndex: 0,
      },
      {
        type: 'mc',
        question: 'A client’s values priorities cause 9 different technology companies to score in their top matches. Under TrueNorth’s sector cap, what happens to their recommended portfolio?',
        options: [
          'All 9 technology companies are included, since they scored the highest',
          'No technology companies are included at all, since the sector is overrepresented',
          'At most 5 of those technology companies are included, and other sectors fill the remaining slots',
          'The client is asked to manually pick which sector to exclude',
        ],
        correctIndex: 2,
      },
      {
        type: 'tf',
        question: 'True or false: TrueNorth’s recommended portfolios can include up to 15 companies total, with no more than 5 from any single sector.',
        options: ['True', 'False'],
        correctIndex: 0,
      },
    ],
  },
];

// A signed-out visitor who clicks "Learn" in the nav -- same
// "stash intent, send to login, finish automatically once signed in"
// pattern as pendingPortfoliosRedirect/pendingWatchlistViewRedirect
// (auth.js), just owned by this file since Learn is otherwise
// self-contained. Consumed in auth.js's onAuthStateChanged.
let pendingLearnRedirect = false;

// { [lessonId]: { completed: bool, lastScore, bestScore, total } }
const learnState = { progress: {}, progressLoaded: false };

const learnLessonViewState = {
  lessonId: null,
  phase: 'lesson', // 'lesson' | 'quiz' | 'result'
  score: null,
  total: null,
};

function learnProgressCollection() {
  return firebaseDb.collection('users').doc(authState.user.uid).collection('learnProgress');
}

async function loadLearnProgress() {
  if (!firebaseReady || !authState.user) return;
  try {
    const snapshot = await learnProgressCollection().get();
    const progress = {};
    snapshot.docs.forEach((doc) => {
      progress[doc.id] = doc.data();
    });
    learnState.progress = progress;
  } catch (err) {
    console.error('loadLearnProgress failed:', err);
  }
  learnState.progressLoaded = true;
}

// Always marks completed:true and keeps the higher of any prior best score
// -- a retry can only improve the recorded best score, never un-complete a
// lesson or lower what's shown. Firestore write failures are logged but
// non-fatal: the score screen (already rendered by the caller before this
// resolves) isn't blocked on it, and the local learnState.progress update
// keeps the hub's badge correct for the rest of this session either way.
async function recordLessonCompletion(lessonId, score, total) {
  const prior = learnState.progress[lessonId];
  const bestScore = prior && typeof prior.bestScore === 'number' ? Math.max(prior.bestScore, score) : score;
  const data = { completed: true, lastScore: score, bestScore, total };
  learnState.progress[lessonId] = { ...prior, ...data };
  if (!firebaseReady || !authState.user) return;
  try {
    await learnProgressCollection()
      .doc(lessonId)
      .set({ ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  } catch (err) {
    console.error('recordLessonCompletion failed:', err);
  }
}

// --- Learn hub -------------------------------------------------------------

async function openLearnHub() {
  state.view = 'learn';
  render();
  if (!learnState.progressLoaded) {
    await loadLearnProgress();
    renderInPlace();
  }
}

function renderLearnHub() {
  const completedCount = LESSONS.filter((l) => learnState.progress[l.id] && learnState.progress[l.id].completed).length;
  const pct = LESSONS.length > 0 ? Math.round((completedCount / LESSONS.length) * 100) : 0;

  appEl.innerHTML = `
    <section class="card learn-hub-card">
      <p class="eyebrow">Learn</p>
      <h1>Values-Investing Lessons</h1>
      <p class="lede">Short lessons on the concepts behind TrueNorth’s scoring, each with a quick quiz to check your understanding. Optional -- nothing else on the site requires finishing these.</p>

      <div class="learn-progress-summary">
        <div class="learn-progress-track"><div class="learn-progress-fill" style="width:${pct}%"></div></div>
        <span class="learn-progress-label">${completedCount} of ${LESSONS.length} lessons complete</span>
      </div>

      <ul class="learn-lesson-list">
        ${LESSONS.map(renderLearnLessonListItem).join('')}
      </ul>

      <div class="nav-row">
        <button type="button" id="learn-back-btn" class="btn btn-secondary">Back</button>
      </div>
    </section>
  `;

  document.querySelectorAll('.learn-lesson-item').forEach((el) => {
    el.addEventListener('click', () => openLearnLesson(el.dataset.lessonId));
    el.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        openLearnLesson(el.dataset.lessonId);
      }
    });
  });

  document.getElementById('learn-back-btn').addEventListener('click', () => {
    state.view = 'intro';
    render();
  });
}

function renderLearnLessonListItem(lesson) {
  const progress = learnState.progress[lesson.id];
  const completed = !!(progress && progress.completed);
  return `
    <li class="learn-lesson-item" data-lesson-id="${lesson.id}" role="button" tabindex="0">
      <div class="learn-lesson-item-info">
        <span class="learn-lesson-item-title">${escapeHtml(lesson.title)}</span>
        <span class="learn-lesson-item-desc">${escapeHtml(lesson.description)}</span>
      </div>
      <span class="tier-badge ${completed ? 'tier-strong' : 'tier-below-threshold'}">${completed ? '✓ Completed' : 'Not started'}</span>
    </li>
  `;
}

// --- Individual lesson (reading -> quiz -> result) --------------------------

function openLearnLesson(lessonId) {
  const lesson = LESSONS.find((l) => l.id === lessonId);
  if (!lesson) return;
  learnLessonViewState.lessonId = lessonId;
  learnLessonViewState.phase = 'lesson';
  learnLessonViewState.score = null;
  learnLessonViewState.total = null;
  state.view = 'learnLesson';
  render();
}

function renderLearnLesson() {
  const lesson = LESSONS.find((l) => l.id === learnLessonViewState.lessonId);
  if (!lesson) {
    // Shouldn't happen in normal use, but don't crash on an unexpected
    // state (e.g. a stale lessonId) -- just fall back to the hub.
    openLearnHub();
    return;
  }
  if (learnLessonViewState.phase === 'quiz') renderLearnLessonQuiz(lesson);
  else if (learnLessonViewState.phase === 'result') renderLearnLessonResult(lesson);
  else renderLearnLessonReading(lesson);
}

function renderLearnLessonReading(lesson) {
  appEl.innerHTML = `
    <section class="card learn-lesson-card">
      <p class="eyebrow">Learn</p>
      <h1>${escapeHtml(lesson.title)}</h1>
      <div class="learn-lesson-body">
        ${lesson.body.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
      </div>
      <div class="nav-row">
        <button type="button" id="learn-lesson-hub-btn" class="btn btn-secondary">Back to Learn</button>
        <button type="button" id="learn-lesson-quiz-btn" class="btn btn-primary">Take the Quiz</button>
      </div>
    </section>
  `;
  document.getElementById('learn-lesson-hub-btn').addEventListener('click', openLearnHub);
  document.getElementById('learn-lesson-quiz-btn').addEventListener('click', () => {
    learnLessonViewState.phase = 'quiz';
    render();
  });
}

function renderLearnLessonQuiz(lesson) {
  appEl.innerHTML = `
    <section class="card learn-lesson-card">
      <p class="eyebrow">Learn</p>
      <h1>${escapeHtml(lesson.title)}</h1>
      <p class="lede">${lesson.quiz.length} question${lesson.quiz.length === 1 ? '' : 's'}. Pick an answer for each, then submit.</p>
      <form id="learn-quiz-form" novalidate>
        ${lesson.quiz.map((q, qi) => renderQuizQuestion(q, qi)).join('')}
        <div class="nav-row">
          <button type="button" id="learn-quiz-back-btn" class="btn btn-secondary">Back to Lesson</button>
          <button type="submit" class="btn btn-primary">Submit Quiz</button>
        </div>
      </form>
    </section>
  `;
  document.getElementById('learn-quiz-back-btn').addEventListener('click', () => {
    learnLessonViewState.phase = 'lesson';
    render();
  });
  document.getElementById('learn-quiz-form').addEventListener('submit', (evt) => {
    evt.preventDefault();
    handleQuizSubmit(lesson);
  });
}

function renderQuizQuestion(question, index) {
  return `
    <fieldset class="quiz-question">
      <legend>${index + 1}. ${escapeHtml(question.question)}</legend>
      <div class="quiz-options">
        ${question.options
          .map(
            (opt, oi) => `
          <label class="quiz-option">
            <input type="radio" name="quiz-q${index}" value="${oi}" required />
            <span>${escapeHtml(opt)}</span>
          </label>
        `
          )
          .join('')}
      </div>
    </fieldset>
  `;
}

// Score is computed purely client-side from the form's selected radio
// values -- a blank (unanswered, since `required` should prevent this, but
// handled defensively anyway) counts as incorrect, never as a crash.
// Completion is recorded regardless of score, per this feature's whole
// point: an attempt is what counts, not a passing grade.
async function handleQuizSubmit(lesson) {
  const formEl = document.getElementById('learn-quiz-form');
  const formData = new FormData(formEl);
  let score = 0;
  lesson.quiz.forEach((question, qi) => {
    const selected = formData.get(`quiz-q${qi}`);
    if (selected !== null && Number(selected) === question.correctIndex) score += 1;
  });
  const total = lesson.quiz.length;

  learnLessonViewState.score = score;
  learnLessonViewState.total = total;
  learnLessonViewState.phase = 'result';
  render();

  await recordLessonCompletion(lesson.id, score, total);
}

function renderLearnLessonResult(lesson) {
  const { score, total } = learnLessonViewState;
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const message =
    pct === 100
      ? 'Perfect score!'
      : pct >= 60
        ? 'Nice work.'
        : 'Lesson complete -- retry the quiz any time to improve your score.';

  appEl.innerHTML = `
    <section class="card learn-lesson-card">
      <p class="eyebrow">Learn</p>
      <h1>${escapeHtml(lesson.title)}</h1>
      <div class="learn-quiz-result">
        <p class="learn-quiz-score">${score}/${total}</p>
        <p class="muted">${escapeHtml(message)}</p>
      </div>
      <div class="nav-row">
        <button type="button" id="learn-result-hub-btn" class="btn btn-secondary">Back to Learn</button>
        <button type="button" id="learn-result-retry-btn" class="btn btn-primary">Retry Quiz</button>
      </div>
    </section>
  `;

  document.getElementById('learn-result-hub-btn').addEventListener('click', openLearnHub);
  document.getElementById('learn-result-retry-btn').addEventListener('click', () => {
    learnLessonViewState.phase = 'quiz';
    learnLessonViewState.score = null;
    learnLessonViewState.total = null;
    render();
  });
}
