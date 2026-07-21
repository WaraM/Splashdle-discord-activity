export const DEFAULT_AVATAR_URL = "https://cdn.discordapp.com/embed/avatars/0.png";

export const getUrlParams = () => new URLSearchParams(window.location.search);

export const getRoomId = () => {
  const params = getUrlParams();
  return params.get("instance_id") || params.get("channel_id") || "local";
};

export const getGuildId = () => {
  const params = getUrlParams();
  return params.get("guild_id") || "global";
};

export const getParticipantId = () => {
  const saved = window.localStorage.getItem("splashdle_participant_id");
  if (saved) return saved;
  const id = `local-${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem("splashdle_participant_id", id);
  return id;
};

export const getPlayerName = () => {
  const params = getUrlParams();
  const fromUrl = params.get("username") || params.get("user_name");
  if (fromUrl) return fromUrl;

  const saved = window.localStorage.getItem("splashdle_player");
  if (saved) return saved;

  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const name = `Joueur ${suffix}`;
  window.localStorage.setItem("splashdle_player", name);
  return name;
};

export const savePlayerName = (name) => {
  if (!name) return;
  window.localStorage.setItem("splashdle_player", name);
};

export const getDisplayName = (user) => user?.global_name || user?.username || "Joueur";

export const getAvatarUrl = (user) => {
  if (!user) return "";
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  }
  const disc = Number.parseInt(user.discriminator ?? "0", 10);
  const index = Number.isFinite(disc) ? disc % 5 : 0;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
};
