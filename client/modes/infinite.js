import { DiscordSDK } from "@discord/embedded-app-sdk";

const FALLBACK = [
  { championKey: "Aatrox", skinNum: 0, name: "Aatrox" },
  { championKey: "Ahri", skinNum: 0, name: "Ahri" },
  { championKey: "Caitlyn", skinNum: 0, name: "Caitlyn" },
  { championKey: "Lux", skinNum: 0, name: "Lux" },
  { championKey: "Jinx", skinNum: 0, name: "Jinx" },
  { championKey: "Vi", skinNum: 0, name: "Vi" },
];

const splashUrl = (puzzle) =>
  `/api/splash?champ=${encodeURIComponent(puzzle.championKey)}&skin=${encodeURIComponent(puzzle.skinNum)}`;

const ROOM_POLL_MS = 2500;
const PRESENCE_POLL_MS = 5000;
const MAX_ZOOM_STEP = 4;
const SKIN_SUGGESTION_LIMIT = 12;

const getRoomId = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get("instance_id") || params.get("channel_id") || "local";
};

const getParticipantId = () => {
  const saved = window.localStorage.getItem("splashdle_participant_id");
  if (saved) return saved;
  const id = `local-${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem("splashdle_participant_id", id);
  return id;
};

const getPlayerName = () => {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("username") || params.get("user_name");
  if (fromUrl) return fromUrl;

  const saved = window.localStorage.getItem("splashdle_player");
  if (saved) return saved;

  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const name = `Joueur ${suffix}`;
  window.localStorage.setItem("splashdle_player", name);
  return name;
};

const getDisplayName = (user) => user?.global_name || user?.username || "Joueur";

const getAvatarUrl = (user) => {
  if (!user) return "";
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  }
  const disc = Number.parseInt(user.discriminator ?? "0", 10);
  const index = Number.isFinite(disc) ? disc % 5 : 0;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
};

const DEFAULT_AVATAR_URL = "https://cdn.discordapp.com/embed/avatars/0.png";

const zoomScaleForStep = (step) => {
  const maxScale = 2.2;
  const minScale = 1.3;
  const clamped = Math.min(MAX_ZOOM_STEP, Math.max(0, step ?? 0));
  const t = MAX_ZOOM_STEP === 0 ? 1 : clamped / MAX_ZOOM_STEP;
  return maxScale - (maxScale - minScale) * t;
};

const puzzleIdFor = (puzzle) => `${puzzle?.championKey ?? ""}_${puzzle?.skinNum ?? 0}`;

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

const sameParticipants = (left, right) =>
  left.length === right.length &&
  left.every(
    (participant, index) =>
      participant.id === right[index]?.id &&
      participant.name === right[index]?.name &&
      participant.avatarUrl === right[index]?.avatarUrl
  );

export function renderInfinite(onBack) {
  const app = document.querySelector("#app");
  const roomId = getRoomId();
  let playerName = getPlayerName();
  let participantId = getParticipantId();
  let participantAvatarUrl = "";
  let discordError = null;

  let championOptions = [];
  let skinOptions = [];
  let skinOptionsLoadedFor = null;
  const autocomplete = {
    open: false,
    focused: false,
    activeIndex: 0,
    filtered: [],
  };
  const skinAutocomplete = {
    open: false,
    focused: false,
    activeIndex: 0,
    filtered: [],
  };
  let blurTimer;
  let skinBlurTimer;

  let state = {
    loading: true,
    error: null,
    puzzle: FALLBACK[0],
    nextPuzzle: null,
    guesses: [],
    solved: false,
    message: "Chargement du puzzle...",
    roomUpdatedAt: 0,
    round: 1,
    participants: [],
    zoomStep: 0,
    focus: createPuzzleFocus(),
    puzzleId: puzzleIdFor(FALLBACK[0]),
    skinAttempted: false,
    skinCorrect: false,
    skinMessage: "Devine le nom du skin.",
  };
  let isActive = true;
  let pollTimer;
  let presenceTimer;

  function setState(updater) {
    if (!isActive) return;
    state = typeof updater === "function" ? updater(state) : updater;
    draw();
  }

  function writeDebug(extra) {
    const payload = {
      roomId,
      ...extra,
      at: new Date().toISOString(),
    };
    try {
      window.localStorage.setItem("splashdle_debug", JSON.stringify(payload));
    } catch (err) {
      console.error("Debug storage error", err);
    }
  }

  function setParticipants(participants) {
    const normalized = Array.isArray(participants)
      ? participants
        .filter((participant) => participant?.id)
        .map((participant) => ({
          id: participant.id,
          name: participant.name || "Joueur",
          avatarUrl: participant.avatarUrl || DEFAULT_AVATAR_URL,
        }))
      : [];

    setState((prev) => {
      if (sameParticipants(prev.participants, normalized)) return prev;
      return {
        ...prev,
        participants: normalized,
      };
    });
  }

  function syncLocalParticipantPreview() {
    setParticipants([
      {
        id: participantId,
        name: playerName,
        avatarUrl: participantAvatarUrl || DEFAULT_AVATAR_URL,
      },
    ]);
  }

  async function fetchRoom() {
    const res = await fetch(`/api/room?roomId=${encodeURIComponent(roomId)}`);
    if (!res.ok) throw new Error("room fetch failed");
    return res.json();
  }

  async function submitGuess(value) {
    const res = await fetch("/api/room/guess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, value, player: playerName }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`guess submit failed: ${res.status} ${body}`);
    }
    return res.json();
  }

  async function requestNewRound() {
    const res = await fetch("/api/room/new-round", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`new round failed: ${res.status} ${body}`);
    }
    return res.json();
  }

  async function fetchChampions() {
    const res = await fetch("/api/champions");
    if (!res.ok) throw new Error("champions fetch failed");
    const data = await res.json();
    championOptions = (data.champions ?? [])
      .map((c) => c.name ?? c.id)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  async function fetchSkins(championKey) {
    const res = await fetch(`/api/skins?champ=${encodeURIComponent(championKey)}`);
    if (!res.ok) throw new Error("skins fetch failed");
    const data = await res.json();
    writeDebug({
      championDebug: {
        championKey,
        version: data.version ?? null,
        fetchedAt: new Date().toISOString(),
        skins: data.skins ?? [],
      },
    });
    skinOptions = (data.skins ?? [])
      .map((s) => s.name ?? "")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    skinOptionsLoadedFor = championKey;
  }

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


  async function syncPresence(previousParticipantId = null) {
    try {
      const res = await fetch("/api/room/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          previousParticipantId,
          participant: {
            id: participantId,
            name: playerName,
            avatarUrl: participantAvatarUrl || DEFAULT_AVATAR_URL,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`presence sync failed: ${res.status} ${body}`);
      }
      const data = await res.json();
      setParticipants(data.participants ?? []);
    } catch (err) {
      console.error("Presence sync error", err);
      syncLocalParticipantPreview();
    }
  }

  function applyRoom(room) {
    setState((prev) => {
      const nextPuzzle = room.puzzle ?? prev.puzzle;
      const nextPuzzleId = puzzleIdFor(nextPuzzle);
      const puzzleChanged = nextPuzzleId !== prev.puzzleId;
      const nextFocus = puzzleChanged ? createPuzzleFocus() : prev.focus;
      if (puzzleChanged) {
        skinOptions = [];
        skinOptionsLoadedFor = null;
        skinAutocomplete.open = false;
        skinAutocomplete.focused = false;
        skinAutocomplete.activeIndex = 0;
        skinAutocomplete.filtered = [];
        writeDebug({
          championDebug: {
            championKey: nextPuzzle?.championKey ?? null,
            skinNum: nextPuzzle?.skinNum ?? 0,
            skinName: nextPuzzle?.skinName ?? null,
            splashUrl: nextPuzzle ? splashUrl(nextPuzzle) : null,
            ddragonSplashUrl: nextPuzzle
              ? `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${nextPuzzle.championKey}_${nextPuzzle.skinNum ?? 0}.jpg`
              : null,
          },
        });
      }
      return {
        ...prev,
        loading: false,
        error: null,
        puzzle: nextPuzzle,
        nextPuzzle: room.nextPuzzle ?? prev.nextPuzzle ?? null,
        guesses: room.guesses ?? [],
        solved: room.solved ?? false,
        roomUpdatedAt: room.updatedAt ?? prev.roomUpdatedAt,
        round: room.round ?? prev.round,
        zoomStep: room.zoomStep ?? prev.zoomStep,
        focus: nextFocus,
        puzzleId: nextPuzzleId,
        skinAttempted: puzzleChanged ? false : prev.skinAttempted,
        skinCorrect: puzzleChanged ? false : prev.skinCorrect,
        skinMessage: puzzleChanged ? "Devine le nom du skin." : prev.skinMessage,
      };
    });
  }

  function preloadPuzzleImage(puzzle) {
    if (!puzzle?.championKey) return;
    const img = new Image();
    img.src = splashUrl(puzzle);
  }

  async function handleSubmit(input) {
    const value = (input ?? "").trim();
    if (!value || state.solved) return;

    try {
      const room = await submitGuess(value);
      applyRoom(room);
      setState((prev) => ({
        ...prev,
        error: null,
      }));
    } catch (err) {
      console.error("Guess submit error", err);
      writeDebug({ guessError: String(err), guessValue: value });
      setState((prev) => ({
        ...prev,
        error: `Impossible d'envoyer la tentative. ${String(err)}`,
      }));
    }
  }

  function handleSkinGuess(input) {
    const value = (input ?? "").trim();
    if (!value || state.skinAttempted) return;

    const expected = (state.puzzle?.skinName ?? "").trim();
    const correct = value.toLowerCase() === expected.toLowerCase();
    setState((prev) => ({
      ...prev,
      skinAttempted: true,
      skinCorrect: correct,
      skinMessage: correct
        ? `Bravo ! C'etait ${expected}.`
        : `Perdu. C'etait ${expected}.`,
    }));
  }

  async function ensureSkinOptions() {
    const championKey = state.puzzle?.championKey;
    if (!championKey || skinOptionsLoadedFor === championKey) return;
    try {
      await fetchSkins(championKey);
      setState((prev) => ({
        ...prev,
      }));
    } catch (err) {
      console.error("Skins fetch error", err);
    }
  }


  async function newRound() {
    const optimisticPuzzle = state.nextPuzzle;
    const optimisticPuzzleId = puzzleIdFor(optimisticPuzzle);

    if (optimisticPuzzle?.championKey) {
      setState((prev) => ({
        ...prev,
        puzzle: optimisticPuzzle,
        nextPuzzle: null,
        guesses: [],
        solved: false,
        round: (prev.round ?? 1) + 1,
        zoomStep: 0,
        focus: createPuzzleFocus(),
        puzzleId: optimisticPuzzleId,
        skinAttempted: false,
        skinCorrect: false,
        skinMessage: "Devine le nom du skin.",
      }));
      skinOptions = [];
      skinOptionsLoadedFor = null;
      skinAutocomplete.open = false;
      skinAutocomplete.focused = false;
      skinAutocomplete.activeIndex = 0;
      skinAutocomplete.filtered = [];
    }

    try {
      const room = await requestNewRound();
      applyRoom(room);
      preloadPuzzleImage(room.nextPuzzle);
    } catch (err) {
      console.error("New round error", err);
      if (optimisticPuzzle?.championKey) {
        try {
          const room = await fetchRoom();
          applyRoom(room);
          preloadPuzzleImage(room.nextPuzzle);
          return;
        } catch (fetchErr) {
          console.error("Room refresh after optimistic round error", fetchErr);
        }
      }
      setState((prev) => ({
        ...prev,
        error: "Impossible de charger un nouveau puzzle.",
      }));
    }
  }


  function filterOptions(value) {
    const excluded = new Set(state.guesses.map((g) => g.value.trim().toLowerCase()).filter(Boolean));
    const query = value.trim().toLowerCase();
    const pool = championOptions.filter((name) => !excluded.has(name.toLowerCase()));
    if (!query) {
      return pool.slice(0, 12);
    }
    return pool.filter((name) => name.toLowerCase().startsWith(query)).slice(0, 12);
  }

  function filterSkinOptions(value) {
    const query = value.trim().toLowerCase();
    if (!query) {
      return skinOptions.slice(0, SKIN_SUGGESTION_LIMIT);
    }
    return skinOptions.filter((name) => name.toLowerCase().includes(query)).slice(0, SKIN_SUGGESTION_LIMIT);
  }

  function renderSkinSuggestions(listEl) {
    listEl.innerHTML = skinAutocomplete.filtered
      .map(
        (name, i) => `
        <div class="suggestion-item ${i === skinAutocomplete.activeIndex ? "active" : ""}" data-index="${i}">
          ${name}
        </div>
      `
      )
      .join("");

    listEl.classList.toggle("open", skinAutocomplete.open);

    listEl.querySelectorAll(".suggestion-item").forEach((item) => {
      const index = Number(item.getAttribute("data-index"));
      item.onpointerenter = () => {
        skinAutocomplete.activeIndex = index;
        renderSkinSuggestions(listEl);
      };
      item.onpointerdown = (e) => {
        e.preventDefault();
        const name = skinAutocomplete.filtered[index];
        if (name) handleSkinGuess(name);
        skinAutocomplete.open = false;
        renderSkinSuggestions(listEl);
      };
    });
  }

  function renderSuggestions(listEl) {
    listEl.innerHTML = autocomplete.filtered
      .map(
        (name, i) => `
        <div class="suggestion-item ${i === autocomplete.activeIndex ? "active" : ""}" data-index="${i}">
          ${name}
        </div>
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
  }

  function draw() {
    const skinModalOpen = state.solved;
    const skinModalHtml = skinModalOpen
      ? `
      <div class="modal-backdrop">
        <div class="modal-card">
          <div class="modal-header">
            <h2>Nom du skin</h2>
            <span class="modal-sub">Un seul essai</span>
          </div>
          <div class="modal-splash">
            <img class="modal-splash-img" src="${splashUrl(state.puzzle)}" alt="Splash art complet" />
          </div>
          <div class="modal-input">
            <div class="guess-field">
              <input id="skin-input" type="text" placeholder="Nom du skin..." ${state.skinAttempted ? "disabled" : ""} />
              <div class="suggestions" id="skin-suggestions"></div>
            </div>
            <button class="icon-btn" id="skin-submit" ${state.skinAttempted ? "disabled" : ""} aria-label="Valider skin">OK</button>
          </div>
          <p class="modal-feedback ${state.skinCorrect ? "good" : ""}">${state.skinMessage}</p>
          ${state.skinAttempted ? '<button class="mode-btn compact" id="skin-replay">Rejouer</button>' : ""}
        </div>
      </div>
      `
      : "";

    const participantsHtml = state.participants.length
      ? state.participants
        .map((participant) => {
          const avatarSrc = participant.avatarUrl || DEFAULT_AVATAR_URL;
          return `
            <div class="connected-item">
              <img class="connected-avatar" src="${avatarSrc}" alt="" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR_URL}';" />
              <span class="connected-name">${participant.name}</span>
            </div>
          `;
        })
        .join("")
      : '<div class="connected-empty">Aucun joueur connecté.</div>';

    app.innerHTML = `
      <div class="connected-panel">
        <div class="connected-title">Connectés</div>
        ${participantsHtml}
      </div>
      ${skinModalHtml}
      <div class="game-shell">
        <div class="game-header">
          <button class="icon-back ghost" id="back-home" aria-label="Retour au menu">←</button>
          <div class="chip">Mode Infini</div>
        </div>

        <div class="game-body">
          <div class="splash-frame">
            <img
              class="splash-img"
              style="transform: scale(${zoomScaleForStep(state.zoomStep)}); object-position: ${state.focus.x}% ${state.focus.y}%;"
              src="${splashUrl(state.puzzle)}"
              alt="Splash art"
            />
          </div>

          <div class="guess-bar">
            <div class="guess-field">
              <input id="guess-input" type="text" placeholder="Nom du champion..." ${state.solved ? "disabled" : ""} />
              <div class="suggestions" id="suggestions"></div>
            </div>
            <button class="icon-btn" id="submit-guess" ${state.solved ? "disabled" : ""} aria-label="Valider">→</button>
          </div>

          ${state.error ? `<p class="feedback">${state.error}</p>` : ""}

          <div class="guess-list" id="guess-list">
            ${state.guesses.length === 0
        ? '<p class="muted center">Aucune tentative pour l’instant.</p>'
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
          .join("")
      }
          </div>

          <div class="game-actions">
            <button class="mode-btn compact" id="replay-round" style="${state.solved ? "" : "display:none"}">Rejouer</button>
          </div>
        </div>
      </div>
    `;

    if (skinModalOpen) {
      ensureSkinOptions();
    }

    const backBtn = document.getElementById("back-home");
    if (backBtn)
      backBtn.onclick = () => {
        isActive = false;
        if (pollTimer) clearInterval(pollTimer);
        if (presenceTimer) clearInterval(presenceTimer);
        onBack?.();
      };

    const skinInput = document.getElementById("skin-input");
    const skinSuggestions = document.getElementById("skin-suggestions");
    const skinSubmitBtn = document.getElementById("skin-submit");
    const skinReplayBtn = document.getElementById("skin-replay");

    if (skinInput && skinSuggestions) {
      const updateSkin = () => {
        skinAutocomplete.filtered = filterSkinOptions(skinInput.value);
        const hasResults = skinAutocomplete.filtered.length > 0;
        skinAutocomplete.open = skinAutocomplete.focused && hasResults;
        skinAutocomplete.activeIndex = Math.min(
          skinAutocomplete.activeIndex,
          skinAutocomplete.filtered.length - 1
        );
        if (skinAutocomplete.activeIndex < 0) skinAutocomplete.activeIndex = 0;
        renderSkinSuggestions(skinSuggestions);
      };

      skinInput.onfocus = () => {
        skinAutocomplete.focused = true;
        updateSkin();
      };
      skinInput.onblur = () => {
        skinAutocomplete.focused = false;
        skinBlurTimer = setTimeout(() => {
          skinAutocomplete.open = false;
          renderSkinSuggestions(skinSuggestions);
        }, 80);
      };
      skinInput.oninput = () => {
        skinAutocomplete.activeIndex = 0;
        skinAutocomplete.focused = true;
        updateSkin();
      };
      skinInput.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const pick = skinAutocomplete.open
            ? skinAutocomplete.filtered[skinAutocomplete.activeIndex]
            : skinInput.value;
          handleSkinGuess(pick);
          skinAutocomplete.open = false;
          renderSkinSuggestions(skinSuggestions);
          return;
        }
        if (e.key === "Escape") {
          skinAutocomplete.open = false;
          renderSkinSuggestions(skinSuggestions);
          return;
        }
        if (e.key === "ArrowDown") {
          if (!skinAutocomplete.open) skinAutocomplete.open = true;
          skinAutocomplete.activeIndex = Math.min(
            skinAutocomplete.filtered.length - 1,
            skinAutocomplete.activeIndex + 1
          );
          renderSkinSuggestions(skinSuggestions);
          e.preventDefault();
          return;
        }
        if (e.key === "ArrowUp") {
          if (!skinAutocomplete.open) skinAutocomplete.open = true;
          skinAutocomplete.activeIndex = Math.max(0, skinAutocomplete.activeIndex - 1);
          renderSkinSuggestions(skinSuggestions);
          e.preventDefault();
        }
      };

      skinSuggestions.onpointerdown = () => {
        if (skinBlurTimer) clearTimeout(skinBlurTimer);
      };
    }

    if (skinSubmitBtn) {
      skinSubmitBtn.onclick = () => {
        handleSkinGuess(skinInput?.value ?? "");
      };
    }
    if (skinReplayBtn) {
      skinReplayBtn.onclick = () => {
        newRound();
      };
    }

    const input = document.getElementById("guess-input");
    const suggestions = document.getElementById("suggestions");
    const submitBtn = document.getElementById("submit-guess");
    const replayBtn = document.getElementById("replay-round");

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
          const pick = autocomplete.open
            ? autocomplete.filtered[autocomplete.activeIndex]
            : input.value;
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

    if (submitBtn) {
      submitBtn.onclick = () => {
        handleSubmit(input?.value ?? "");
      };
    }
    if (replayBtn) replayBtn.onclick = newRound;
  }

  async function init() {
    try {
      window.localStorage.removeItem("splashdle_debug");
    } catch (err) {
      console.error("Debug reset error", err);
    }

    draw();
    try {
      const [room] = await Promise.all([fetchRoom(), fetchChampions()]);
      applyRoom(room);
      preloadPuzzleImage(room.nextPuzzle);
    } catch (err) {
      console.error("Initial room error", err);
      setState((prev) => ({
        ...prev,
        loading: false,
        error: "Impossible de charger le puzzle.",
        puzzle: FALLBACK[Math.floor(Math.random() * FALLBACK.length)],
        message: "Mode degrade (liste reduite).",
      }));
    }

    syncLocalParticipantPreview();
    await syncPresence();

    try {
      const previousParticipantId = participantId;
      const discordResult = await initDiscord();
      if (discordResult?.user) {
        const name = getDisplayName(discordResult.user);
        playerName = name;
        participantId = discordResult.user.id || participantId;
        participantAvatarUrl = getAvatarUrl(discordResult.user) || DEFAULT_AVATAR_URL;
        window.localStorage.setItem("splashdle_player", name);
        syncLocalParticipantPreview();
        await syncPresence(previousParticipantId);
      }
    } catch (err) {
      discordError = String(err);
      console.error("Discord init error", err);
      writeDebug({ discordError });
    }
    presenceTimer = setInterval(() => {
      if (!isActive) return;
      syncPresence();
    }, PRESENCE_POLL_MS);

    pollTimer = setInterval(async () => {
      try {
        if (!isActive) return;
        const room = await fetchRoom();
        if (!room?.updatedAt || room.updatedAt === state.roomUpdatedAt) return;
        applyRoom(room);
        preloadPuzzleImage(room.nextPuzzle);
      } catch (err) {
        console.error("Room polling error", err);
      }
    }, ROOM_POLL_MS);
  }


  init();
}




