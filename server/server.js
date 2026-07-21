import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { Redis } from "@upstash/redis";

dotenv.config({ path: "../.env" });

const app = express();
const port = 3001;
const isVercel = process.env.VERCEL === "1";

app.use(express.json());

const MAX_ZOOM_STEP = 4;
const PUZZLE_BUFFER_SIZE = 10;
const ROOM_TTL_SECONDS = 60 * 60 * 12;
const PRESENCE_TTL_MS = 15000;
const DAILY_PROGRESS_TTL_SECONDS = 60 * 60 * 24 * 45;
const DAILY_PUZZLE_TTL_SECONDS = 60 * 60 * 24 * 45;
const DAILY_STATS_TTL_SECONDS = 60 * 60 * 24 * 365;
const DAILY_TIMEZONE = "Europe/Paris";

const CHAMPIONS_TTL_MS = 1000 * 60 * 60 * 6;
let championsCache = {
  at: 0,
  version: null,
  champions: null,
};
const SKINS_TTL_MS = 1000 * 60 * 60 * 6;
const skinsCache = new Map();
const championDetailsCache = new Map();
const rooms = new Map();
const dailyPuzzles = new Map();
const dailyProgress = new Map();
const dailyStats = new Map();

const redis = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
  ? new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    })
  : null;

function roomKey(roomId) {
  return `room:${roomId}`;
}

function dailyPuzzleKey(guildId, dayKey) {
  return `daily:puzzle:${guildId}:${dayKey}`;
}

function dailyProgressKey(guildId, dayKey, playerId) {
  return `daily:progress:${guildId}:${dayKey}:${playerId}`;
}

function dailyStatsKey(guildId, playerId) {
  return `daily:stats:${guildId}:${playerId}`;
}

function guildScope(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "global";
}

function playerScope(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "local-player";
}

function playerNameScope(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "Joueur";
}

function dayKeyFor(date = new Date(), timeZone = DAILY_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function addDays(dayKey, delta) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + delta);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function average(total, count) {
  return count > 0 ? total / count : 0;
}

function toDisplayStats(stats) {
  const totalSolved = Number(stats?.totalSolved ?? 0);
  const totalAttempts = Number(stats?.totalAttempts ?? 0);
  const totalDurationMs = Number(stats?.totalDurationMs ?? 0);
  return {
    playerId: stats?.playerId ?? null,
    playerName: stats?.playerName ?? "Joueur",
    currentStreak: Number(stats?.currentStreak ?? 0),
    totalSolved,
    averageAttempts: average(totalAttempts, totalSolved),
    averageDurationMs: average(totalDurationMs, totalSolved),
    bestTimeMs: Number(stats?.bestTimeMs ?? 0),
    lastSolvedDayKey: stats?.lastSolvedDayKey ?? null,
  };
}

async function loadStored(store, key) {
  if (!redis) {
    return store.get(key) ?? null;
  }
  const raw = await redis.get(key);
  if (!raw) return null;
  if (typeof raw === "string") {
    return JSON.parse(raw);
  }
  return raw;
}

async function saveStored(store, key, value, ttlSeconds) {
  if (!redis) {
    store.set(key, value);
    return value;
  }
  await redis.set(key, JSON.stringify(value), { ex: ttlSeconds });
  return value;
}

async function listStoredByPrefix(store, prefix) {
  if (!redis) {
    return [...store.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
  }
  const keys = await redis.keys(`${prefix}*`);
  if (!Array.isArray(keys) || keys.length === 0) return [];
  return Promise.all(keys.map((key) => loadStored(store, key)));
}

function filterSplashableSkins(skins, championName) {
  const base = Array.isArray(skins) ? skins : [];
  const nonChroma = base.filter((skin) => skin && skin.parentSkin == null);
  const nonDefault = nonChroma.filter((skin) => Number(skin?.num ?? 0) !== 0);
  if (nonDefault.length > 0) return nonDefault;
  if (nonChroma.length > 0) return nonChroma;
  return [{ num: 0, name: championName }];
}

function normalizeSkinEntry(skins, targetSkinNum, championName) {
  const base = Array.isArray(skins) ? skins : [];
  const byNum = new Map(base.map((skin) => [Number(skin?.num ?? 0), skin]));

  let current = byNum.get(Number(targetSkinNum));
  const visited = new Set();

  while (current?.parentSkin != null && !visited.has(Number(current.num))) {
    visited.add(Number(current.num));
    current = byNum.get(Number(current.parentSkin));
  }

  if (current) {
    return {
      num: current.num ?? 0,
      name: current.name ?? championName,
    };
  }

  return {
    num: 0,
    name: championName,
  };
}

function normalizeRoom(room) {
  if (!room) return null;
  return {
    roomId: room.roomId,
    puzzle: room.puzzle ?? null,
    nextPuzzles: Array.isArray(room.nextPuzzles) ? room.nextPuzzles : [],
    guesses: Array.isArray(room.guesses) ? room.guesses : [],
    solved: Boolean(room.solved),
    round: Number(room.round ?? 1),
    updatedAt: Number(room.updatedAt ?? Date.now()),
    zoomStep: Number(room.zoomStep ?? 0),
    participants: room.participants && typeof room.participants === "object" ? room.participants : {},
  };
}

function listParticipants(room) {
  return Object.values(room?.participants ?? {});
}

async function loadRoom(roomId) {
  const raw = await loadStored(rooms, roomKey(roomId));
  return raw ? normalizeRoom(raw) : null;
}

async function saveRoom(room) {
  const normalized = normalizeRoom(room);
  if (!normalized) return null;
  await saveStored(rooms, roomKey(normalized.roomId), normalized, ROOM_TTL_SECONDS);
  return normalized;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed fetch ${url}: ${res.status}`);
  }
  return res.json();
}

async function loadChampions() {
  const now = Date.now();
  if (championsCache.champions && now - championsCache.at < CHAMPIONS_TTL_MS) {
    return championsCache;
  }

  let version = "15.24.1";
  try {
    const versions = await fetchJson("https://ddragon.leagueoflegends.com/api/versions.json");
    version = Array.isArray(versions) ? versions[0] : versions.version ?? "latest";
  } catch (err) {
    console.error("Failed to load versions, using fallback", err);
  }

  const data = await fetchJson(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`);

  const champions = Object.values(data.data ?? {}).map((champ) => ({
    id: champ.id,
    key: champ.key,
    name: champ.name,
  }));

  championsCache = { at: now, version, champions };
  return championsCache;
}

async function loadSkinsForChampion(championId, version) {
  const cacheKey = `${version}:${championId}`;
  const cached = skinsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SKINS_TTL_MS) {
    return cached.skins;
  }

  const data = await loadChampionDetails(championId, version);
  const champ = data?.data?.[championId];
  const skins = filterSplashableSkins(champ?.skins, champ?.name ?? championId);
  skinsCache.set(cacheKey, { at: Date.now(), skins });
  return skins;
}

async function loadChampionDetails(championId, version) {
  const cacheKey = `${version}:${championId}`;
  const cached = championDetailsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SKINS_TTL_MS) {
    return cached.data;
  }

  const data = await fetchJson(
    `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion/${championId}.json`
  );
  championDetailsCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

async function resolveSplashUrl(championId, skinNum) {
  await loadChampions();

  const requestedUrl = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${championId}_${skinNum}.jpg`;
  const requested = await fetch(requestedUrl);
  if (requested.ok) {
    return { upstream: requested, url: requestedUrl, resolvedSkinNum: skinNum };
  }

  try {
    const data = await loadChampionDetails(championId, championsCache.version);
    const champ = data?.data?.[championId];
    const fallbackSkinNum = champ?.skins?.find((skin) => String(skin?.num) === String(skinNum))?.parentSkin ?? 0;
    const fallbackUrl = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${championId}_${fallbackSkinNum}.jpg`;
    const fallback = await fetch(fallbackUrl);
    if (fallback.ok) {
      return { upstream: fallback, url: fallbackUrl, resolvedSkinNum: fallbackSkinNum };
    }
  } catch (err) {
    console.error("Splash fallback resolve error", err);
  }

  return { upstream: requested, url: requestedUrl, resolvedSkinNum: skinNum };
}

async function pickRandomPuzzle(excludeChampion) {
  const champions = championsCache.champions ?? [];
  if (!champions.length) return null;

  const pool = excludeChampion ? champions.filter((c) => c.id !== excludeChampion) : champions;
  const champ = pool[Math.floor(Math.random() * pool.length)] ?? champions[0];
  const skins = await loadSkinsForChampion(champ.id, championsCache.version);
  const skin = skins[Math.floor(Math.random() * skins.length)] ?? { num: 0, name: champ.name };

  return {
    championKey: champ.id,
    skinNum: skin.num ?? 0,
    skinName: skin.name ?? champ.name ?? champ.id ?? "Unknown",
    name: champ.name ?? champ.id ?? "Unknown",
  };
}

async function normalizePuzzle(puzzle) {
  if (!puzzle?.championKey) return puzzle;

  await loadChampions();
  const data = await loadChampionDetails(puzzle.championKey, championsCache.version);
  const champ = data?.data?.[puzzle.championKey];
  const normalizedSkin = normalizeSkinEntry(
    champ?.skins,
    puzzle.skinNum ?? 0,
    champ?.name ?? puzzle.name ?? puzzle.championKey
  );

  return {
    ...puzzle,
    championKey: puzzle.championKey,
    skinNum: normalizedSkin.num,
    skinName: normalizedSkin.name,
    name: champ?.name ?? puzzle.name ?? puzzle.championKey,
  };
}

async function fillPuzzleBuffer(room, targetSize = PUZZLE_BUFFER_SIZE) {
  await loadChampions();

  if (!Array.isArray(room.nextPuzzles)) {
    room.nextPuzzles = [];
  }

  const usedChampionKeys = new Set([
    room.puzzle?.championKey,
    ...room.nextPuzzles.map((puzzle) => puzzle?.championKey),
  ]);
  const allChampions = championsCache.champions ?? [];
  let attempts = 0;
  const maxAttempts = Math.max(allChampions.length * 4, targetSize * 4, 20);

  while (room.nextPuzzles.length < targetSize && attempts < maxAttempts) {
    attempts += 1;
    const availableChampions = allChampions.filter(
      (champ) => champ?.id && !usedChampionKeys.has(champ.id)
    );
    const sourceChampions = availableChampions.length > 0 ? availableChampions : allChampions;
    const champ = sourceChampions[Math.floor(Math.random() * sourceChampions.length)];
    if (!champ?.id) break;

    const skins = await loadSkinsForChampion(champ.id, championsCache.version);
    const skin = skins[Math.floor(Math.random() * skins.length)] ?? { num: 0, name: champ.name };
    const nextPuzzle = await normalizePuzzle({
      championKey: champ.id,
      skinNum: skin.num ?? 0,
      skinName: skin.name ?? champ.name ?? champ.id ?? "Unknown",
      name: champ.name ?? champ.id ?? "Unknown",
    });
    if (!nextPuzzle) continue;

    room.nextPuzzles.push(nextPuzzle);
    if (availableChampions.length > 0) {
      usedChampionKeys.add(nextPuzzle.championKey);
    }
  }
}

function roomView(room) {
  const participants = listParticipants(room).map(({ lastSeen, ...participant }) => participant);
  return {
    ...room,
    participants,
    nextPuzzle: room.nextPuzzles?.[0] ?? null,
  };
}

async function getOrCreateRoom(roomId) {
  const existing = await loadRoom(roomId);
  if (existing) {
    existing.puzzle = await normalizePuzzle(existing.puzzle);
    await fillPuzzleBuffer(existing);
    await saveRoom(existing);
    return existing;
  }

  await loadChampions();
  const puzzle = await normalizePuzzle(await pickRandomPuzzle());
  if (!puzzle) return null;

  const room = {
    roomId,
    puzzle,
    nextPuzzles: [],
    guesses: [],
    solved: false,
    round: 1,
    updatedAt: Date.now(),
    zoomStep: 0,
    participants: {},
  };
  await fillPuzzleBuffer(room);
  await saveRoom(room);
  return room;
}

function pruneParticipants(room, ttlMs = PRESENCE_TTL_MS) {
  const now = Date.now();
  for (const [id, participant] of Object.entries(room.participants ?? {})) {
    if (!participant?.lastSeen || now - participant.lastSeen > ttlMs) {
      delete room.participants[id];
    }
  }
}

async function getOrCreateDailyPuzzle(guildId, dayKey = dayKeyFor()) {
  const key = dailyPuzzleKey(guildId, dayKey);
  const existing = await loadStored(dailyPuzzles, key);
  if (existing) {
    return normalizePuzzle(existing);
  }

  await loadChampions();
  const puzzle = await normalizePuzzle(await pickRandomPuzzle());
  if (!puzzle) return null;
  const stored = { ...puzzle, guildId, dayKey, createdAt: Date.now() };
  await saveStored(dailyPuzzles, key, stored, DAILY_PUZZLE_TTL_SECONDS);
  return stored;
}

async function getDailyProgress(guildId, dayKey, playerId) {
  return loadStored(dailyProgress, dailyProgressKey(guildId, dayKey, playerId));
}

async function saveDailyProgress(progress) {
  await saveStored(
    dailyProgress,
    dailyProgressKey(progress.guildId, progress.dayKey, progress.playerId),
    progress,
    DAILY_PROGRESS_TTL_SECONDS
  );
  return progress;
}

async function getDailyStats(guildId, playerId) {
  return loadStored(dailyStats, dailyStatsKey(guildId, playerId));
}

async function saveDailyStats(stats) {
  await saveStored(dailyStats, dailyStatsKey(stats.guildId, stats.playerId), stats, DAILY_STATS_TTL_SECONDS);
  return stats;
}

async function getOrCreateDailyProgress(guildId, playerId, playerName, dayKey = dayKeyFor()) {
  const existing = await getDailyProgress(guildId, dayKey, playerId);
  if (existing) {
    existing.playerName = playerNameScope(playerName);
    return existing;
  }

  const puzzle = await getOrCreateDailyPuzzle(guildId, dayKey);
  if (!puzzle) return null;

  const progress = {
    guildId,
    dayKey,
    playerId,
    playerName: playerNameScope(playerName),
    puzzle,
    guesses: [],
    solved: false,
    zoomStep: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };

  await saveDailyProgress(progress);
  return progress;
}

function getDailyStatusLabel(progress) {
  if (!progress) return "Pas encore joue";
  if (progress.solved) {
    return `Reussi en ${progress.guesses?.length ?? 0} essai${(progress.guesses?.length ?? 0) > 1 ? "s" : ""}`;
  }
  if ((progress.guesses?.length ?? 0) > 0) {
    return `En cours - ${progress.guesses.length} essai${progress.guesses.length > 1 ? "s" : ""}`;
  }
  return "Pas encore joue";
}

function buildDailySummary(progress, stats, dayKey) {
  const hasCompletedToday = Boolean(progress?.solved);
  const inProgress = Boolean(progress && !progress.solved);
  return {
    dayKey,
    today: {
      canPlay: !hasCompletedToday,
      hasCompletedToday,
      inProgress,
      attempts: progress?.guesses?.length ?? 0,
      durationMs: Number(progress?.durationMs ?? 0),
      statusLabel: getDailyStatusLabel(progress),
    },
    stats: toDisplayStats(stats ?? {}),
  };
}

function buildDailyGameView(progress) {
  return {
    guildId: progress.guildId,
    dayKey: progress.dayKey,
    puzzle: progress.puzzle,
    guesses: progress.guesses ?? [],
    solved: Boolean(progress.solved),
    zoomStep: Number(progress.zoomStep ?? 0),
    startedAt: Number(progress.startedAt ?? Date.now()),
    updatedAt: Number(progress.updatedAt ?? Date.now()),
    durationMs: Number(progress.durationMs ?? 0),
    statusLabel: getDailyStatusLabel(progress),
  };
}

async function updateDailyStatsOnSolve(guildId, playerId, playerName, progress) {
  const existing = (await getDailyStats(guildId, playerId)) ?? {
    guildId,
    playerId,
    playerName,
    currentStreak: 0,
    totalSolved: 0,
    totalAttempts: 0,
    totalDurationMs: 0,
    bestTimeMs: 0,
    lastSolvedDayKey: null,
  };

  if (existing.lastSolvedDayKey === progress.dayKey) {
    existing.playerName = playerName;
    await saveDailyStats(existing);
    return existing;
  }

  const previousDayKey = addDays(progress.dayKey, -1);
  const nextStreak = existing.lastSolvedDayKey === previousDayKey ? Number(existing.currentStreak ?? 0) + 1 : 1;
  const durationMs = Number(progress.durationMs ?? 0);
  const attempts = Array.isArray(progress.guesses) ? progress.guesses.length : 0;

  const updated = {
    ...existing,
    playerName,
    currentStreak: nextStreak,
    totalSolved: Number(existing.totalSolved ?? 0) + 1,
    totalAttempts: Number(existing.totalAttempts ?? 0) + attempts,
    totalDurationMs: Number(existing.totalDurationMs ?? 0) + durationMs,
    bestTimeMs:
      Number(existing.bestTimeMs ?? 0) > 0 ? Math.min(Number(existing.bestTimeMs ?? 0), durationMs) : durationMs,
    lastSolvedDayKey: progress.dayKey,
  };

  await saveDailyStats(updated);
  return updated;
}

function toDailyProgressEntry(progress) {
  return {
    playerId: progress?.playerId ?? null,
    playerName: progress?.playerName ?? "Joueur",
    solved: Boolean(progress?.solved),
    attempts: Array.isArray(progress?.guesses) ? progress.guesses.length : 0,
    durationMs: Number(progress?.durationMs ?? 0),
    updatedAt: Number(progress?.updatedAt ?? 0),
  };
}

async function getDailyLeaderboard(guildId, scope = "global") {
  if (scope === "global") {
    const entries = await listStoredByPrefix(dailyStats, `daily:stats:${guildId}:`);
    return {
      scope,
      dayKey: dayKeyFor(),
      entries: entries
        .filter(Boolean)
        .map((entry) => toDisplayStats(entry))
        .sort((left, right) => {
          if (right.currentStreak !== left.currentStreak) return right.currentStreak - left.currentStreak;
          if (left.averageAttempts !== right.averageAttempts) return left.averageAttempts - right.averageAttempts;
          if (left.averageDurationMs !== right.averageDurationMs) return left.averageDurationMs - right.averageDurationMs;
          return String(left.playerName).localeCompare(String(right.playerName));
        }),
    };
  }

  const targetDayKey = scope === "yesterday" ? addDays(dayKeyFor(), -1) : dayKeyFor();
  const entries = await listStoredByPrefix(dailyProgress, `daily:progress:${guildId}:${targetDayKey}:`);
  return {
    scope,
    dayKey: targetDayKey,
    entries: entries
      .filter(Boolean)
      .map((entry) => toDailyProgressEntry(entry))
      .sort((left, right) => {
        if (Number(right.solved) !== Number(left.solved)) return Number(right.solved) - Number(left.solved);
        if ((left.durationMs || Number.MAX_SAFE_INTEGER) !== (right.durationMs || Number.MAX_SAFE_INTEGER)) {
          return (left.durationMs || Number.MAX_SAFE_INTEGER) - (right.durationMs || Number.MAX_SAFE_INTEGER);
        }
        if (left.attempts !== right.attempts) return left.attempts - right.attempts;
        if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
        return String(left.playerName).localeCompare(String(right.playerName));
      }),
  };
}

app.post("/api/token", async (req, res) => {
  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: process.env.VITE_DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: req.body.code,
      ...(req.body.code_verifier ? { code_verifier: req.body.code_verifier } : {}),
    }),
  });

  const rawBody = await response.text();
  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch (err) {
    payload = { error: "invalid_json", details: rawBody };
  }

  if (!response.ok) {
    res.status(response.status).send({
      error: "token_exchange_failed",
      details: payload,
    });
    return;
  }

  const { access_token } = payload;
  if (!access_token) {
    res.status(500).send({ error: "missing_access_token", details: payload });
    return;
  }

  res.send({ access_token });
});

app.get("/api/splash", async (req, res) => {
  const champ = req.query.champ;
  const skin = req.query.skin ?? "0";

  if (!champ) {
    res.status(400).send("champ query param required");
    return;
  }

  try {
    const { upstream, resolvedSkinNum, url } = await resolveSplashUrl(champ, skin);
    if (!upstream.ok) {
      res.status(upstream.status).send("Failed to fetch splash");
      return;
    }

    res.set("X-Splash-Source", url);
    res.set("X-Splash-Skin-Num", String(resolvedSkinNum));
    res.set("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
    const buffer = await upstream.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Splash proxy error", err);
    res.status(500).send("Proxy error");
  }
});

app.get("/api/champions", async (req, res) => {
  try {
    const data = await loadChampions();
    res.json({ version: data.version, champions: data.champions });
  } catch (err) {
    console.error("Champions fetch error", err);
    res.status(500).send("Failed to load champions");
  }
});

app.get("/api/skins", async (req, res) => {
  try {
    await loadChampions();
    const champ = typeof req.query.champ === "string" ? req.query.champ : "";
    if (!champ) {
      res.status(400).send("champ query param required");
      return;
    }
    const skins = await loadSkinsForChampion(champ, championsCache.version);
    res.json({
      championKey: champ,
      version: championsCache.version,
      skins: (skins ?? []).map((skin) => ({
        num: skin.num ?? 0,
        name: skin.name ?? champ,
        splashUrl: `/api/splash?champ=${encodeURIComponent(champ)}&skin=${encodeURIComponent(skin.num ?? 0)}`,
        ddragonSplashUrl: `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${champ}_${skin.num ?? 0}.jpg`,
      })),
    });
  } catch (err) {
    console.error("Skins fetch error", err);
    res.status(500).send("Failed to load skins");
  }
});

app.get("/api/puzzle", async (req, res) => {
  try {
    await loadChampions();
    const exclude = typeof req.query.exclude === "string" ? req.query.exclude : undefined;
    const puzzle = await normalizePuzzle(await pickRandomPuzzle(exclude));
    if (!puzzle) {
      res.status(500).send("No puzzle available");
      return;
    }
    res.json(puzzle);
  } catch (err) {
    console.error("Puzzle fetch error", err);
    res.status(500).send("Failed to load puzzle");
  }
});

app.get("/api/daily/summary", async (req, res) => {
  try {
    const guildId = guildScope(req.query.guildId);
    const playerId = playerScope(req.query.playerId);
    const playerName = playerNameScope(req.query.playerName);
    const dayKey = dayKeyFor();
    const progress = await getDailyProgress(guildId, dayKey, playerId);
    const stats = await getDailyStats(guildId, playerId);
    if (progress && progress.playerName !== playerName) {
      progress.playerName = playerName;
      await saveDailyProgress(progress);
    }
    if (stats && stats.playerName !== playerName) {
      stats.playerName = playerName;
      await saveDailyStats(stats);
    }
    res.json(buildDailySummary(progress, stats, dayKey));
  } catch (err) {
    console.error("Daily summary error", err);
    res.status(500).send("Failed to load daily summary");
  }
});

app.get("/api/daily/leaderboard", async (req, res) => {
  try {
    const guildId = guildScope(req.query.guildId);
    const requestedScope = typeof req.query.scope === "string" ? req.query.scope : "global";
    const scope = ["global", "today", "yesterday"].includes(requestedScope) ? requestedScope : "global";
    const leaderboard = await getDailyLeaderboard(guildId, scope);
    res.json({ guildId, ...leaderboard });
  } catch (err) {
    console.error("Daily leaderboard error", err);
    res.status(500).send("Failed to load daily leaderboard");
  }
});

app.get("/api/daily/game", async (req, res) => {
  try {
    const guildId = guildScope(req.query.guildId);
    const playerId = playerScope(req.query.playerId);
    const playerName = playerNameScope(req.query.playerName);
    const progress = await getOrCreateDailyProgress(guildId, playerId, playerName, dayKeyFor());
    if (!progress) {
      res.status(500).send("No daily puzzle available");
      return;
    }
    progress.playerName = playerName;
    await saveDailyProgress(progress);
    res.json(buildDailyGameView(progress));
  } catch (err) {
    console.error("Daily game error", err);
    res.status(500).send("Failed to load daily game");
  }
});

app.post("/api/daily/guess", async (req, res) => {
  try {
    const guildId = guildScope(req.body.guildId);
    const playerId = playerScope(req.body.playerId);
    const playerName = playerNameScope(req.body.playerName);
    const value = typeof req.body.value === "string" ? req.body.value.trim() : "";

    if (!value) {
      res.status(400).send("value required");
      return;
    }

    const progress = await getOrCreateDailyProgress(guildId, playerId, playerName, dayKeyFor());
    if (!progress) {
      res.status(500).send("No daily puzzle available");
      return;
    }

    if (progress.solved) {
      res.json(buildDailyGameView(progress));
      return;
    }

    const correct = value.toLowerCase() === progress.puzzle.name.toLowerCase();
    progress.playerName = playerName;
    progress.guesses = [...(progress.guesses ?? []), { value, correct, player: playerName, at: Date.now() }].slice(-50);
    if (correct) {
      progress.solved = true;
      progress.solvedAt = Date.now();
      progress.durationMs = Math.max(0, progress.solvedAt - Number(progress.startedAt ?? progress.solvedAt));
      await updateDailyStatsOnSolve(guildId, playerId, playerName, progress);
    } else {
      progress.zoomStep = Math.min(MAX_ZOOM_STEP, Number(progress.zoomStep ?? 0) + 1);
    }
    progress.updatedAt = Date.now();
    await saveDailyProgress(progress);
    res.json(buildDailyGameView(progress));
  } catch (err) {
    console.error("Daily guess error", err);
    res.status(500).send("Failed to submit daily guess");
  }
});

app.get("/api/room", async (req, res) => {
  try {
    const roomId = typeof req.query.roomId === "string" && req.query.roomId.trim() ? req.query.roomId : "local";
    const room = await getOrCreateRoom(roomId);
    if (!room) {
      res.status(500).send("No room available");
      return;
    }
    res.json(roomView(room));
  } catch (err) {
    console.error("Room fetch error", err);
    res.status(500).send("Failed to load room");
  }
});

app.post("/api/room/guess", async (req, res) => {
  try {
    const roomId = typeof req.body.roomId === "string" && req.body.roomId.trim() ? req.body.roomId : "local";
    const value = typeof req.body.value === "string" ? req.body.value.trim() : "";
    const player = typeof req.body.player === "string" && req.body.player.trim() ? req.body.player.trim() : "Joueur";
    if (!value) {
      res.status(400).send("value required");
      return;
    }

    const room = await getOrCreateRoom(roomId);
    if (!room) {
      res.status(500).send("No room available");
      return;
    }

    const correct = value.toLowerCase() === room.puzzle.name.toLowerCase();
    room.guesses = [...room.guesses, { value, correct, player, at: Date.now() }].slice(-50);
    if (correct) room.solved = true;
    if (!correct) {
      room.zoomStep = Math.min(MAX_ZOOM_STEP, (room.zoomStep ?? 0) + 1);
    }
    room.updatedAt = Date.now();
    await saveRoom(room);
    res.json(roomView(room));
  } catch (err) {
    console.error("Room guess error", err);
    res.status(500).send("Failed to submit guess");
  }
});

app.post("/api/room/new-round", async (req, res) => {
  try {
    const roomId = typeof req.body.roomId === "string" && req.body.roomId.trim() ? req.body.roomId : "local";
    const room = await getOrCreateRoom(roomId);
    if (!room) {
      res.status(500).send("No room available");
      return;
    }

    await fillPuzzleBuffer(room, 1);
    const next = room.nextPuzzles.shift() ?? await normalizePuzzle(await pickRandomPuzzle(room.puzzle?.championKey));
    if (!next) {
      res.status(500).send("No puzzle available");
      return;
    }
    room.puzzle = next;
    await fillPuzzleBuffer(room);
    room.guesses = [];
    room.solved = false;
    room.round = (room.round ?? 1) + 1;
    room.zoomStep = 0;
    room.updatedAt = Date.now();
    await saveRoom(room);
    res.json(roomView(room));
  } catch (err) {
    console.error("Room new round error", err);
    res.status(500).send("Failed to create new round");
  }
});

app.get("/api/room/presence", async (req, res) => {
  try {
    const roomId = typeof req.query.roomId === "string" && req.query.roomId.trim() ? req.query.roomId : "local";
    const room = await getOrCreateRoom(roomId);
    if (!room) {
      res.status(500).send("No room available");
      return;
    }
    pruneParticipants(room);
    await saveRoom(room);
    res.json({
      participants: listParticipants(room).map(({ lastSeen, ...p }) => p),
    });
  } catch (err) {
    console.error("Room presence error", err);
    res.status(500).send("Failed to load presence");
  }
});

app.post("/api/room/presence", async (req, res) => {
  try {
    const roomId = typeof req.body.roomId === "string" && req.body.roomId.trim() ? req.body.roomId : "local";
    const participant = req.body.participant ?? {};
    const previousParticipantId =
      typeof req.body.previousParticipantId === "string" && req.body.previousParticipantId.trim()
        ? req.body.previousParticipantId.trim()
        : null;
    const id = typeof participant.id === "string" && participant.id.trim() ? participant.id.trim() : null;
    if (!id) {
      res.status(400).send("participant id required");
      return;
    }

    const room = await getOrCreateRoom(roomId);
    if (!room) {
      res.status(500).send("No room available");
      return;
    }

    if (previousParticipantId && previousParticipantId !== id) {
      delete room.participants[previousParticipantId];
    }

    room.participants[id] = {
      id,
      name: typeof participant.name === "string" ? participant.name : "Joueur",
      avatarUrl: typeof participant.avatarUrl === "string" ? participant.avatarUrl : "",
      lastSeen: Date.now(),
    };
    pruneParticipants(room);
    await saveRoom(room);
    res.json({
      participants: listParticipants(room).map(({ lastSeen, ...p }) => p),
    });
  } catch (err) {
    console.error("Room presence update error", err);
    res.status(500).send("Failed to update presence");
  }
});

if (!isVercel) {
  app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
  });
}

export default app;



