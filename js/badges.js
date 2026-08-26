/**
 * Badges: earnable, equippable achievement medallions. Currently just one
 * (Values Literacy Certified, for completing every Learn lesson -- see
 * js/learn.js), but structured as a list of { id, name, description,
 * lockedHint, isEarned() } entries so more badges can be added later
 * without reworking storage, award logic, or the My Badges UI -- adding a
 * badge is just adding another entry here with its own requirement check.
 *
 * Storage: users/{uid}/badges/{badgeId} holds one doc per EARNED badge
 * ({ earned, earnedAt }); which badge (if any) is currently equipped lives
 * in the existing users/{uid}/meta/badges doc ({ equippedBadgeId }),
 * reusing the meta subcollection's already-granted per-owner Firestore
 * rule rather than needing a new one just for that one field. Only the
 * badges subcollection itself needed a new firestore.rules entry.
 */

const BADGES = [
  {
    id: 'values-literacy-certified',
    name: 'Values Literacy Certified',
    description: 'Completed all 8 Learn lessons.',
    lockedHint: 'Complete all 8 Learn lessons to earn this badge.',
    isEarned: () => LESSONS.every((l) => learnState.progress[l.id] && learnState.progress[l.id].completed),
  },
];

// A signed-out visitor who clicks "My Badges" -- same pattern as
// pendingLearnRedirect (js/learn.js).
let pendingMyBadgesRedirect = false;

const badgeState = {
  loaded: false,
  earnedIds: new Set(),
  equippedId: null,
  error: null,
  // Set true the moment a badge is freshly earned this session (see
  // checkAndAwardBadges below); consumed by the next renderLearnHub call,
  // which plays the gift-box-opening animation once and clears it. Not
  // persisted -- a page reload just shows the already-open box instead of
  // replaying the animation, which is fine since the earned-badge popup
  // already showed once and isn't re-shown either.
  hubAnimationPending: false,
};

function badgesCollection() {
  return firebaseDb.collection('users').doc(authState.user.uid).collection('badges');
}

function badgeMetaDoc() {
  return firebaseDb.collection('users').doc(authState.user.uid).collection('meta').doc('badges');
}

// Only marks loaded true on SUCCESS, same reasoning as
// loadLearnProgress's own fix (js/learn.js): a failed load (most likely a
// Firestore security-rules mismatch -- see that function's comment) leaves
// loaded false so the next visit to Learn or My Badges retries instead of
// getting stuck showing "not earned"/no header badge for the rest of the
// session. badgeState.error is shown on My Badges so a real failure is
// visible instead of silently looking like lost data.
async function loadBadgeState() {
  if (!firebaseReady || !authState.user) return;
  badgeState.error = null;
  try {
    const [badgesSnap, metaSnap] = await Promise.all([badgesCollection().get(), badgeMetaDoc().get()]);
    badgeState.earnedIds = new Set(badgesSnap.docs.filter((doc) => doc.data().earned).map((doc) => doc.id));
    badgeState.equippedId = metaSnap.exists ? metaSnap.data().equippedBadgeId || null : null;
    badgeState.loaded = true;
  } catch (err) {
    console.error('loadBadgeState failed:', err);
    badgeState.error = describeFirestoreError(err, 'Could not load your badges'); // js/auth.js
  }
}

// Checks every badge's requirement against the current in-memory progress
// and awards (records to Firestore, and optionally pops up) any newly-met
// one not already recorded as earned. Two call sites, two purposes:
//   - handleQuizSubmit (js/learn.js), showPopup: true -- the actual
//     celebratory trigger, right after the quiz that pushes the client
//     over the line.
//   - openLearnHub/openMyBadgesView, showPopup: false -- a silent backfill
//     for a badge whose requirement was already met before this feature
//     existed (or in an earlier session), so a returning client isn't
//     permanently stuck showing "not earned" for something they already
//     did. Idempotent either way -- a badge already in earnedIds is
//     skipped, so this is safe to call on every hub/My-Badges visit.
async function checkAndAwardBadges(showPopup) {
  for (const badge of BADGES) {
    if (badgeState.earnedIds.has(badge.id)) continue;
    if (!badge.isEarned()) continue;

    badgeState.earnedIds.add(badge.id);
    if (showPopup) badgeState.hubAnimationPending = true;

    if (firebaseReady && authState.user) {
      try {
        await badgesCollection()
          .doc(badge.id)
          .set({ earned: true, earnedAt: firebase.firestore.FieldValue.serverTimestamp() });
      } catch (err) {
        console.error('Awarding badge failed:', err);
        badgeState.error = describeFirestoreError(err, 'Could not save your earned badge'); // js/auth.js
      }
    }

    if (showPopup) openBadgeEarnedModal(badge);
  }
}

async function equipBadge(badgeId) {
  badgeState.equippedId = badgeId;
  badgeState.error = null;
  renderAccountWidget(); // js/auth.js -- refreshes the header badge slot
  if (!firebaseReady || !authState.user) return;
  try {
    await badgeMetaDoc().set({ equippedBadgeId: badgeId }, { merge: true });
  } catch (err) {
    console.error('equipBadge failed:', err);
    badgeState.error = describeFirestoreError(err, 'Could not save your equipped badge'); // js/auth.js
  }
}

async function unequipBadge() {
  badgeState.equippedId = null;
  badgeState.error = null;
  renderAccountWidget(); // js/auth.js
  if (!firebaseReady || !authState.user) return;
  try {
    await badgeMetaDoc().set({ equippedBadgeId: null }, { merge: true });
  } catch (err) {
    console.error('unequipBadge failed:', err);
    badgeState.error = describeFirestoreError(err, 'Could not save your unequipped badge'); // js/auth.js
  }
}

// --- Icons -------------------------------------------------------------

// Gold medallion reusing the site's own compass glyph (see
// compassMotifIcon, app.js) at its center, so an earned badge reads as
// unmistakably TrueNorth's own rather than a generic achievement icon. The
// pale --bg ring behind the gold disc exists purely so the medallion still
// reads clearly against the navy header -- without it, the medallion's own
// navy accents blend straight into the header background.
function badgeMedallionIcon() {
  return `
    <svg viewBox="0 0 48 48" class="badge-medallion-icon" aria-hidden="true">
      <path d="M17 33 L11 46 L18 43 L21 47 Z" fill="var(--gold)" />
      <path d="M31 33 L37 46 L30 43 L27 47 Z" fill="var(--gold)" />
      <circle cx="24" cy="21" r="17" fill="var(--bg)" />
      <circle cx="24" cy="21" r="15.5" fill="var(--gold)" stroke="var(--navy)" stroke-width="1.4" />
      <circle cx="24" cy="21" r="11.5" fill="none" stroke="var(--navy)" stroke-width="1" opacity="0.5" />
      <circle cx="24" cy="21" r="8" fill="none" stroke="var(--navy)" stroke-width="1.3" />
      <path d="M24 14.5 L26.3 20.5 L24 23 L21.7 20.5 Z" fill="var(--navy)" />
    </svg>
  `;
}

// The Learn hub's progress-bar gift box. One markup, three resting states
// for the lid group via CSS class (see .gift-lid* rules, styles.css):
// 'closed' (still working through the lessons), 'opening' (the one-time
// CSS animation, played the first renderLearnHub after a fresh badge
// award -- see badgeState.hubAnimationPending), and 'open' (every
// subsequent render once all lessons are done).
function giftBoxIcon(lidState) {
  const lidClass = lidState === 'closed' ? 'gift-lid' : lidState === 'opening' ? 'gift-lid gift-lid-opening' : 'gift-lid gift-lid-open';
  return `
    <svg viewBox="0 0 40 40" class="gift-box-icon" aria-hidden="true">
      <rect x="6" y="16" width="28" height="18" rx="2" class="gift-box-body" />
      <rect x="17" y="16" width="6" height="18" class="gift-box-ribbon-v" />
      <g class="${lidClass}">
        <rect x="4" y="10" width="32" height="7" rx="1.5" class="gift-box-lid" />
        <path d="M20 10c-3-6-10-6-10-1c0 3 5 1 10 1Z" class="gift-box-bow" />
        <path d="M20 10c3-6 10-6 10-1c0 3-5 1-10 1Z" class="gift-box-bow" />
      </g>
    </svg>
  `;
}

// Small header-badge span shown in the account widget (see
// renderAccountWidget, auth.js) when a badge is equipped -- empty string
// (no placeholder slot) when nothing is equipped, per this feature's own
// "no empty slot visible" requirement.
function renderEquippedBadgeHtml() {
  if (!badgeState.equippedId) return '';
  const badge = BADGES.find((b) => b.id === badgeState.equippedId);
  if (!badge) return '';
  return `<span class="header-badge" title="${escapeHtml(badge.name)}" aria-label="Equipped badge: ${escapeHtml(badge.name)}">${badgeMedallionIcon()}</span>`;
}

// --- Badge-earned pop-up (one-time, see checkAndAwardBadges above) -------

function handleBadgeEarnedModalKeydown(evt) {
  if (evt.key === 'Escape') closeBadgeEarnedModal();
  trapModalTabFocus(evt, '#badge-earned-modal-overlay .modal-card'); // js/app.js
}

// Same document.body-append pattern as the Terms/Delete-Account modals
// (auth.js) -- independent of whatever screen is rendered through #app, so
// it can appear on top of the quiz-result screen without disturbing it.
function openBadgeEarnedModal(badge) {
  if (document.getElementById('badge-earned-modal-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'badge-earned-modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card badge-earned-card" role="dialog" aria-modal="true" aria-labelledby="badge-earned-title">
      <div class="badge-earned-visual">${badgeMedallionIcon()}</div>
      <h2 id="badge-earned-title">${escapeHtml(badge.name)}</h2>
      <p class="badge-earned-text">
        You've completed every Learn lesson. This badge is yours to keep -- equip it now to show it in the
        header, or decide later from My Badges.
      </p>
      <div class="nav-row badge-earned-actions">
        <button type="button" id="badge-earned-dismiss-btn" class="btn btn-secondary">Maybe later</button>
        <button type="button" id="badge-earned-equip-btn" class="btn btn-primary">Equip</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  focusModal('#badge-earned-modal-overlay .modal-card'); // js/app.js

  document.getElementById('badge-earned-dismiss-btn').addEventListener('click', closeBadgeEarnedModal);
  document.getElementById('badge-earned-equip-btn').addEventListener('click', async () => {
    await equipBadge(badge.id);
    closeBadgeEarnedModal();
  });
  overlay.addEventListener('click', (evt) => {
    if (evt.target === overlay) closeBadgeEarnedModal();
  });
  document.addEventListener('keydown', handleBadgeEarnedModalKeydown);
}

function closeBadgeEarnedModal() {
  const overlay = document.getElementById('badge-earned-modal-overlay');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', handleBadgeEarnedModalKeydown);
}

// --- My Badges view ------------------------------------------------------

async function openMyBadgesView() {
  state.view = 'myBadges';
  render();
  // Self-sufficient regardless of whether Learn was ever opened this
  // session -- isEarned() (BADGES above) reads learnState.progress, so a
  // client landing here directly still gets a correct locked/earned split
  // and the same silent-backfill treatment as openLearnHub.
  if (!learnState.progressLoaded) await loadLearnProgress();
  if (!badgeState.loaded) await loadBadgeState();
  await checkAndAwardBadges(false);
  renderInPlace();
}

function renderMyBadges() {
  // badgeState.error (or learnState.error, since isEarned() above depends
  // on Learn progress too) takes priority over the loading spinner --
  // otherwise a failed load would show a spinner forever instead of the
  // actual problem. See loadBadgeState/loadLearnProgress: a failed load
  // leaves *Loaded/loaded false, which is exactly why this checks the
  // error first rather than assuming false = still in flight.
  const error = badgeState.error || learnState.error;
  const loading = !error && (!learnState.progressLoaded || !badgeState.loaded);
  appEl.innerHTML = `
    <section class="card my-badges-card">
      <p class="eyebrow">Account</p>
      <h1>My Badges</h1>
      <p class="lede">Achievements earned across TrueNorth. Equip one to show it in the header.</p>
      ${
        error
          ? `<div class="error-text-row"><p class="error-text">${escapeHtml(error)}</p><button type="button" id="badges-retry-btn" class="btn-link-action">Try Again</button></div>`
          : ''
      }
      ${
        loading
          ? `<p class="muted">${spinnerHtml('Loading…')}</p>`
          : error
            ? ''
            : `<ul class="badge-list">${BADGES.map(renderBadgeListItem).join('')}</ul>`
      }
      <div class="nav-row">
        <button type="button" id="my-badges-back-btn" class="btn btn-secondary">Back</button>
      </div>
    </section>
  `;

  document.getElementById('my-badges-back-btn').addEventListener('click', () => {
    state.view = 'intro';
    render();
  });

  document.querySelectorAll('.badge-equip-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await equipBadge(btn.dataset.badgeId);
      renderInPlace();
    });
  });
  document.querySelectorAll('.badge-unequip-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await unequipBadge();
      renderInPlace();
    });
  });

  const retryBtn = document.getElementById('badges-retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = 'Retrying…';
      // Retries both -- isEarned() depends on Learn progress too (see the
      // comment above), and either one could be the one that actually failed.
      await Promise.all([loadBadgeState(), loadLearnProgress()]); // js/learn.js
      if (state.view === 'myBadges') renderInPlace();
    });
  }
}

function renderBadgeListItem(badge) {
  const earned = badgeState.earnedIds.has(badge.id);

  if (!earned) {
    return `
      <li class="badge-list-item badge-list-item-locked">
        <div class="badge-list-visual badge-list-visual-locked">${badgeMedallionIcon()}</div>
        <div class="badge-list-info">
          <span class="badge-list-name">${escapeHtml(badge.name)}</span>
          <span class="badge-list-desc muted">${escapeHtml(badge.lockedHint)}</span>
        </div>
      </li>
    `;
  }

  const equipped = badgeState.equippedId === badge.id;
  return `
    <li class="badge-list-item">
      <div class="badge-list-visual">${badgeMedallionIcon()}</div>
      <div class="badge-list-info">
        <span class="badge-list-name">${escapeHtml(badge.name)}</span>
        <span class="badge-list-desc muted">${escapeHtml(badge.description)}${equipped ? ' -- Equipped' : ''}</span>
      </div>
      ${
        equipped
          ? `<button type="button" class="btn-link-action badge-unequip-btn" data-badge-id="${badge.id}">Unequip</button>`
          : `<button type="button" class="btn-link-action badge-equip-btn" data-badge-id="${badge.id}">Equip</button>`
      }
    </li>
  `;
}
