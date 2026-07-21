import { DiscordSDK } from "@discord/embedded-app-sdk";
import {
  DEFAULT_AVATAR_URL,
  getAvatarUrl,
  getDisplayName,
  getGuildId,
  getParticipantId,
  getPlayerName,
  savePlayerName,
} from "../lib/session";

const FALLBACK = { championKey: "Aatrox", skinNum: 1, name: "Aatrox" };
const ROOM_POLL_MS = 2500;
const MAX_ZOOM_STEP = 4;

const splashUrl = (puzzle) =>
  `/api/splash?champ=${encodeURIComponent(puzzle.championKey)}&skin=${encodeURIComponent(puzzle.skinNum)}`;

const zoomScaleForStep = (step) => {
  const maxScale = 2.2;
  const minScale = 1.3;
  const clamped = Math.min(MAX_ZOOM_STEP, Math.max(0, step ?? 0));
  const t = MAX_ZOOM_STEP === 0 ? 1 : clamped / MAX_ZOOM_STEP;
  return maxScale - (maxScale - minScale) * t;
};

const randomBetween = (min, max) => min + Math.random() * (max - min);

const pickFocusAxis = () => {
  const edgeBiased = Math.random() < 0.88;
  if (edgeBiased) {
    return Math.random() < 0.5 ? randomBetween(24, 39) : randomBetween(61, 76);
  }
  const middle = randomBetween(30, 70);
  if (middle > 46 && middle < 54) return middle < 50 ? 46 : 54;
  return middle;
};

const createPuzzleFocus = () => ({
  x: pickFocusAxis(),
  y: pickFocusAxis(),
});

const formatDuration = (ms) => {
  if (!ms || ms < 1000) return "-";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
};

const formatAverage = (value, digits = 1) => {
  if (!Number.isFinite(value) || value <= 0) return "-";
  return value.toFixed(digits);
};

export function renderDaily(onBack) {
  const app = document.querySelector("#app");
  const guildId = getGuildId();
  let playerName = getPlayerName();
  let playerId = getParticipantId();
  let participantAvatarUrl = "";
  let identityInitialized = false;
  let identityPromise = null;

  async function initDiscord() {
    const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;
    if (!clientId) return null;

    const sdk = new DiscordSDK(clientId);
    await sdk.ready();

    const authorizeResult = await sdk.commands.authorize({
      client_id: clientId,
      response_type: "code",
      prompt: "none",
      scope: ["identify"],
    });
    const code = authorizeResult?.code;
    const codeVerifier = authorizeResult?.code_verifier ?? authorizeResult?.codeVerifier;
    const tokenRes = await fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: codeVerifier }),
    });
    if (!tokenRes.ok) {
      const errorBody = await tokenRes.text();
      throw new Error(`token exchange failed: ${tokenRes.status} ${errorBody}`);
    }
    const { access_token } = await tokenRes.json();
    if (!access_token) throw new Error("token exchange missing access_token");
    const auth = await sdk.commands.authenticate({ access_token });
    return { sdk, user: auth.user };
  }

  async function ensureDiscordIdentity() {
    if (identityInitialized) return;
    if (identityPromise) {
      await identityPromise;
      return;
    }

    identityPromise = (async () => {
      try {
        const discordResult = await initDiscord();
        if (discordResult?.user) {
          playerName = getDisplayName(discordResult.user);
          playerId = discordResult.user.id || playerId;
          participantAvatarUrl = getAvatarUrl(discordResult.user) || DEFAULT_AVATAR_URL;
          savePlayerName(playerName);
        }
      } catch (err) {
        console.error("Discord init error", err);
      } finally {
        identityInitialized = true;
      }
    })();

    await identityPromise;
    identityPromise = null;
  }

  function renderLoading() {
    app.innerHTML = `
      <div class="screen daily-screen">
        <header class="hero">
          <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;">
            <button class="ghost" id="back-home">&larr;</button>
            <div class="chip">Mode Quotidien</div>
          </div>
          <h1>Defi du jour</h1>
          <p class="lede">Chargement de ton profil quotidien...</p>
        </header>
      </div>
    `;

    const backBtn = document.getElementById("back-home");
    if (backBtn) backBtn.onclick = () => onBack?.();
  }

  async function fetchSummary() {
    const res = await fetch(`/api/daily/summary?guildId=${encodeURIComponent(guildId)}&playerId=${encodeURIComponent(playerId)}&playerName=${encodeURIComponent(playerName)}`);
    if (!res.ok) throw new Error("daily summary fetch failed");
    return res.json();
  }

  async function fetchLeaderboard() {
    const res = await fetch(`/api/daily/leaderboard?guildId=${encodeURIComponent(guildId)}`);
    if (!res.ok) throw new Error("daily leaderboard fetch failed");
    return res.json();
  }

  async function fetchGame() {
    const res = await fetch(`/api/daily/game?guildId=${encodeURIComponent(guildId)}&playerId=${encodeURIComponent(playerId)}&playerName=${encodeURIComponent(playerName)}`);
    if (!res.ok) throw new Error("daily game fetch failed");
    return res.json();
  }

  async function submitGuess(value) {
    const res = await fetch("/api/daily/guess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId, playerId, playerName, value }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`daily guess failed: ${res.status} ${body}`);
    }
    return res.json();
  }

  async function loadSummaryScreen() {
    renderLoading();

    try {
      const summary = await fetchSummary();
      renderSummary(summary);
    } catch (err) {
      app.innerHTML = `
        <div class="screen daily-screen">
          <header class="hero">
            <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;">
              <button class="ghost" id="back-home">&larr; Retour</button>
              <div class="chip">Mode Quotidien</div>
            </div>
            <h1>Defi du jour</h1>
            <p class="feedback">Impossible de charger le mode quotidien. ${String(err)}</p>
          </header>
        </div>
      `;
      const backBtn = document.getElementById("back-home");
      if (backBtn) backBtn.onclick = () => onBack?.();
    }
  }

  function renderSummary(summary) {
    const stats = summary?.stats ?? {};
    const today = summary?.today ?? {};
    const buttonLabel = today.inProgress ? "Reprendre" : today.canPlay ? "Jouer" : "Deja joue aujourd'hui";

    app.innerHTML = `
      <div class="screen daily-screen">
        <header class="hero">
          <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;">
            <button class="ghost" id="back-home">&larr; Retour</button>
            <div class="chip">Mode Quotidien</div>
          </div>
          <h1>Defi du jour</h1>
          <p class="lede">Un seul splash art par jour, les memes conditions pour tous les joueurs du serveur.</p>
        </header>

        <section class="stats-grid">
          <article class="stats-card highlight">
            <div class="stats-label">Statut du jour</div>
            <div class="stats-value">${today.statusLabel ?? "Pas encore joue"}</div>
            <div class="stats-sub">${summary.dayKey ?? ""}</div>
          </article>
          <article class="stats-card">
            <div class="stats-label">Streak actuelle</div>
            <div class="stats-value">${stats.currentStreak ?? 0}</div>
          </article>
          <article class="stats-card">
            <div class="stats-label">Quotidiens reussis</div>
            <div class="stats-value">${stats.totalSolved ?? 0}</div>
          </article>
          <article class="stats-card">
            <div class="stats-label">Essais moyens</div>
            <div class="stats-value">${formatAverage(stats.averageAttempts)}</div>
          </article>
          <article class="stats-card">
            <div class="stats-label">Temps moyen</div>
            <div class="stats-value">${formatDuration(stats.averageDurationMs)}</div>
          </article>
          <article class="stats-card">
            <div class="stats-label">Meilleur temps</div>
            <div class="stats-value">${formatDuration(stats.bestTimeMs)}</div>
          </article>
        </section>

        <div class="mode-stack daily-actions">
          <button class="mode-btn" id="daily-play" ${today.canPlay ? "" : "disabled"}>${buttonLabel}</button>
          <button class="ghost ghost-strong" id="daily-leaderboard">Leaderboard du serveur</button>
        </div>
      </div>
    `;

    const backBtn = document.getElementById("back-home");
    if (backBtn) backBtn.onclick = () => onBack?.();

    const playBtn = document.getElementById("daily-play");
    if (playBtn && today.canPlay) {
      playBtn.onclick = () => renderGame();
    }

    const leaderboardBtn = document.getElementById("daily-leaderboard");
    if (leaderboardBtn) {
      leaderboardBtn.onclick = () => renderLeaderboard();
    }
  }

  async function renderLeaderboard() {
    app.innerHTML = `
      <div class="screen daily-screen">
        <header class="hero">
          <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;">
            <button class="ghost" id="back-daily">&larr; Retour</button>
            <button class="ghost" id="back-home">Accueil</button>
          </div>
          <h1>Classement du serveur</h1>
          <p class="lede">Streak, efficacite et regularite sur le mode quotidien.</p>
        </header>
        <div class="leaderboard-card" id="leaderboard-body">Chargement...</div>
      </div>
    `;

    const backBtn = document.getElementById("back-daily");
    if (backBtn) backBtn.onclick = () => loadSummaryScreen();

    const homeBtn = document.getElementById("back-home");
    if (homeBtn) homeBtn.onclick = () => onBack?.();

    try {
      const data = await fetchLeaderboard();
      const entries = data.entries ?? [];
      const body = document.getElementById("leaderboard-body");
      if (!body) return;

      body.innerHTML = entries.length
        ? `
          <div class="leaderboard-head leaderboard-row">
            <span>#</span>
            <span>Joueur</span>
            <span>Streak</span>
            <span>Essais</span>
            <span>Temps</span>
          </div>
          ${entries
          .map(
            (entry, index) => `
                <div class="leaderboard-row">
                  <span>${index + 1}</span>
                  <span>${entry.playerName}</span>
                  <span>${entry.currentStreak}</span>
                  <span>${formatAverage(entry.averageAttempts)}</span>
                  <span>${formatDuration(entry.averageDurationMs)}</span>
                </div>
              `
          )
          .join("")}
        `
        : '<p class="muted center">Aucune donnee disponible pour le moment.</p>';
    } catch (err) {
      const body = document.getElementById("leaderboard-body");
      if (body) body.innerHTML = `<p class="feedback">Impossible de charger le leaderboard. ${String(err)}</p>`;
    }
  }

  async function renderGame() {
    let championOptions = [];
    let isActive = true;
    let pollTimer;
    const autocomplete = {
      open: false,
      focused: false,
      activeIndex: 0,
      filtered: [],
    };
    let blurTimer;
    let state = {
      loading: true,
      error: null,
      puzzle: FALLBACK,
      guesses: [],
      solved: false,
      updatedAt: 0,
      zoomStep: 0,
      focus: createPuzzleFocus(),
      participants: [],
      statusLabel: "Chargement...",
    };

    const setState = (updater) => {
      if (!isActive) return;
      state = typeof updater === "function" ? updater(state) : updater;
      draw();
    };

    const setParticipants = (participants) => {
      const normalized = Array.isArray(participants)
        ? participants.filter((participant) => participant?.id).map((participant) => ({
          id: participant.id,
          name: participant.name || "Joueur",
          avatarUrl: participant.avatarUrl || DEFAULT_AVATAR_URL,
        }))
        : [];
      setState((prev) => ({ ...prev, participants: normalized }));
    };

    async function fetchChampions() {
      const res = await fetch("/api/champions");
      if (!res.ok) throw new Error("champions fetch failed");
      const data = await res.json();
      championOptions = (data.champions ?? []).map((c) => c.name ?? c.id).filter(Boolean).sort((a, b) => a.localeCompare(b));
    }

    const filterOptions = (value) => {
      const excluded = new Set(state.guesses.map((g) => g.value.trim().toLowerCase()).filter(Boolean));
      const query = value.trim().toLowerCase();
      const pool = championOptions.filter((name) => !excluded.has(name.toLowerCase()));
      if (!query) return pool.slice(0, 12);
      return pool.filter((name) => name.toLowerCase().startsWith(query)).slice(0, 12);
    };

    const renderSuggestions = (listEl) => {
      listEl.innerHTML = autocomplete.filtered
        .map(
          (name, i) => `
            <div class="suggestion-item ${i === autocomplete.activeIndex ? "active" : ""}" data-index="${i}">${name}</div>
          `
        )
        .join("");
      listEl.classList.toggle("open", autocomplete.open);
      listEl.querySelectorAll(".suggestion-item").forEach((item) => {
        const index = Number(item.getAttribute("data-index"));
        item.onpointerenter = () => {
          autocomplete.activeIndex = index;
          renderSuggestions(listEl);
        };
        item.onpointerdown = (e) => {
          e.preventDefault();
          const name = autocomplete.filtered[index];
          if (name) handleSubmit(name);
          autocomplete.open = false;
          renderSuggestions(listEl);
        };
      });
    };

    const applyGame = (game) => {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: null,
        puzzle: game.puzzle ?? prev.puzzle,
        guesses: game.guesses ?? [],
        solved: game.solved ?? false,
        updatedAt: game.updatedAt ?? prev.updatedAt,
        zoomStep: game.zoomStep ?? prev.zoomStep,
        statusLabel: game.statusLabel ?? prev.statusLabel,
        focus: game.updatedAt !== prev.updatedAt ? createPuzzleFocus() : prev.focus,
      }));
      setParticipants([
        {
          id: playerId,
          name: playerName,
          avatarUrl: participantAvatarUrl || DEFAULT_AVATAR_URL,
        },
      ]);
    };

    async function handleSubmit(input) {
      const value = (input ?? "").trim();
      if (!value || state.solved) return;
      try {
        const game = await submitGuess(value);
        applyGame(game);
      } catch (err) {
        setState((prev) => ({ ...prev, error: `Impossible d'envoyer la tentative. ${String(err)}` }));
      }
    }

    function draw() {
      const participantsHtml = state.participants.length
        ? state.participants
          .map(
            (participant) => `
                <div class="connected-item">
                  <img class="connected-avatar" src="${participant.avatarUrl}" alt="" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR_URL}';" />
                  <span class="connected-name">${participant.name}</span>
                </div>
              `
          )
          .join("")
        : '<div class="connected-empty">Aucun joueur connecte.</div>';

      const solvedPanel = state.solved
        ? `
          <div class="daily-finish-card">
            <div class="stats-label">Termine pour aujourd'hui</div>
            <div class="stats-value">${state.puzzle?.name ?? "Champion trouve"}</div>
            <p class="muted center">Tu peux retourner au resume ou consulter le leaderboard.</p>
            <div class="game-actions">
              <button class="ghost" id="daily-summary-btn">Retour au resume</button>
              <button class="mode-btn compact" id="daily-leaderboard-btn">Leaderboard</button>
            </div>
          </div>
        `
        : "";

      app.innerHTML = `
        <div class="connected-panel">
          <div class="connected-title">Connectes</div>
          ${participantsHtml}
        </div>
        <div class="game-shell">
          <div class="game-header">
            <button class="icon-back ghost" id="back-daily-game" aria-label="Retour">&larr;</button>
            <div class="chip">Quotidien ${state.statusLabel ? `&bull; ${state.statusLabel}` : ""}</div>
          </div>
          <div class="game-body">
            <div class="splash-frame">
              <img class="splash-img" style="transform: scale(${zoomScaleForStep(state.zoomStep)}); object-position: ${state.focus.x}% ${state.focus.y}%;" src="${splashUrl(state.puzzle)}" alt="Splash art" />
            </div>
            <div class="guess-bar">
              <div class="guess-field">
                <input id="guess-input" type="text" placeholder="Nom du champion..." ${state.solved ? "disabled" : ""} />
                <div class="suggestions" id="suggestions"></div>
              </div>
              <button class="icon-btn" id="submit-guess" ${state.solved ? "disabled" : ""} aria-label="Valider">&rarr;</button>
            </div>
            ${state.error ? `<p class="feedback">${state.error}</p>` : ""}
            <div class="guess-list">
              ${state.guesses.length === 0
          ? '<p class="muted center">Aucune tentative pour l\'instant.</p>'
          : [...state.guesses]
            .reverse()
            .map(
              (g) => `
                        <div class="guess-item ${g.correct ? "good" : "bad"}">
                          <span class="guess-text">${g.value}</span>
                          <span class="guess-meta">${g.player ?? ""}</span>
                        </div>
                      `
            )
            .join("")}
            </div>
            ${solvedPanel}
          </div>
        </div>
      `;

      const backBtn = document.getElementById("back-daily-game");
      if (backBtn) {
        backBtn.onclick = () => {
          isActive = false;
          if (pollTimer) clearInterval(pollTimer);
          loadSummaryScreen();
        };
      }

      const summaryBtn = document.getElementById("daily-summary-btn");
      if (summaryBtn) summaryBtn.onclick = () => {
        isActive = false;
        if (pollTimer) clearInterval(pollTimer);
        loadSummaryScreen();
      };

      const leaderboardBtn = document.getElementById("daily-leaderboard-btn");
      if (leaderboardBtn) leaderboardBtn.onclick = () => {
        isActive = false;
        if (pollTimer) clearInterval(pollTimer);
        renderLeaderboard();
      };

      const input = document.getElementById("guess-input");
      const suggestions = document.getElementById("suggestions");
      const submitBtn = document.getElementById("submit-guess");

      if (input && suggestions) {
        const update = () => {
          autocomplete.filtered = filterOptions(input.value);
          const hasResults = autocomplete.filtered.length > 0;
          autocomplete.open = autocomplete.focused && hasResults;
          autocomplete.activeIndex = Math.min(autocomplete.activeIndex, autocomplete.filtered.length - 1);
          if (autocomplete.activeIndex < 0) autocomplete.activeIndex = 0;
          renderSuggestions(suggestions);
        };

        input.focus();
        input.onfocus = () => {
          autocomplete.focused = true;
          update();
        };
        input.onblur = () => {
          autocomplete.focused = false;
          blurTimer = setTimeout(() => {
            autocomplete.open = false;
            renderSuggestions(suggestions);
          }, 80);
        };
        input.oninput = () => {
          autocomplete.activeIndex = 0;
          autocomplete.focused = true;
          update();
        };
        input.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const pick = autocomplete.open ? autocomplete.filtered[autocomplete.activeIndex] : input.value;
            handleSubmit(pick);
            autocomplete.open = false;
            renderSuggestions(suggestions);
            return;
          }
          if (e.key === "Escape") {
            autocomplete.open = false;
            renderSuggestions(suggestions);
            return;
          }
          if (e.key === "ArrowDown") {
            if (!autocomplete.open) autocomplete.open = true;
            autocomplete.activeIndex = Math.min(autocomplete.filtered.length - 1, autocomplete.activeIndex + 1);
            renderSuggestions(suggestions);
            e.preventDefault();
            return;
          }
          if (e.key === "ArrowUp") {
            if (!autocomplete.open) autocomplete.open = true;
            autocomplete.activeIndex = Math.max(0, autocomplete.activeIndex - 1);
            renderSuggestions(suggestions);
            e.preventDefault();
          }
        };

        suggestions.onpointerdown = () => {
          if (blurTimer) clearTimeout(blurTimer);
        };
      }

      if (submitBtn) submitBtn.onclick = () => handleSubmit(input?.value ?? "");
    }

    draw();
    try {
      const [game] = await Promise.all([fetchGame(), fetchChampions()]);
      applyGame(game);
    } catch (err) {
      setState((prev) => ({ ...prev, loading: false, error: `Impossible de charger le defi du jour. ${String(err)}` }));
    }

    pollTimer = setInterval(async () => {
      try {
        if (!isActive) return;
        const game = await fetchGame();
        if (!game?.updatedAt || game.updatedAt === state.updatedAt) return;
        applyGame(game);
      } catch (err) {
        console.error("Daily polling error", err);
      }
    }, ROOM_POLL_MS);
  }

  async function init() {
    renderLoading();
    await ensureDiscordIdentity();
    await loadSummaryScreen();
  }

  init();
}
