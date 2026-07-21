import "./style.css";
import { renderDaily } from "./modes/daily";
import { renderInfinite } from "./modes/infinite";

const app = document.querySelector("#app");

const modes = [
  { key: "infinite", label: "Mode Infini", enabled: true },
  { key: "daily", label: "Mode Quotidien", enabled: true },
  { key: "duel", label: "Mode Duel (Bientot !)", enabled: false },
];

function navigate(screen) {
  app.innerHTML = "";

  if (screen === "home") {
    renderHome();
    return;
  }

  if (screen === "infinite") {
    renderInfinite(() => navigate("home"));
    return;
  }

  if (screen === "daily") {
    renderDaily(() => navigate("home"));
    return;
  }

  if (screen === "debug") {
    renderDebug(() => navigate("home"));
    return;
  }

  renderHome();
}

function renderHome() {
  app.innerHTML = `
    <div class="screen">
      <header class="hero">
        <h1>Splashdle</h1>
        <p class="lede">Devine le champion a partir de son splash art. Choisis un mode pour commencer.</p>
      </header>

      <div class="mode-stack" id="mode-stack"></div>

      <div class="footer">
        <button class="ghost" id="debug-btn">Debug API</button>
      </div>
    </div>
  `;

  const stack = document.getElementById("mode-stack");
  modes.forEach((mode) => {
    const btn = document.createElement("button");
    btn.className = "mode-btn";
    btn.textContent = mode.label;

    if (!mode.enabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", () => navigate(mode.key));
    }

    stack.appendChild(btn);
  });

  const debugBtn = document.getElementById("debug-btn");
  if (debugBtn) debugBtn.onclick = () => navigate("debug");
}

function renderDebug(onBack) {
  const getDebugInfo = () => {
    try {
      const raw = window.localStorage.getItem("splashdle_debug");
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return { error: String(err) };
    }
  };

  app.innerHTML = `
    <div class="screen">
      <header class="hero">
        <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;">
          <button class="ghost" id="back-home">&larr; Retour</button>
          <div class="chip">Debug API</div>
        </div>
        <p class="lede">Test du proxy et des donnees champion/skins.</p>
      </header>

      <div class="mode-stack">
        <button class="mode-btn" id="test-champions">Tester /api/champions</button>
        <button class="mode-btn" id="test-splash">Tester /api/splash (Aatrox_1)</button>
        <button class="mode-btn" id="test-current-champion">Debug champion courant</button>
      </div>

      <pre class="debug-log" id="debug-log">Cliquer sur un bouton pour lancer un test.</pre>
    </div>
  `;

  const logEl = document.getElementById("debug-log");
  const write = (msg) => {
    if (logEl) logEl.textContent = msg;
  };

  const backBtn = document.getElementById("back-home");
  if (backBtn) backBtn.onclick = () => onBack?.();

  const btnChamp = document.getElementById("test-champions");
  if (btnChamp) {
    btnChamp.onclick = async () => {
      write("Appel /api/champions...");
      try {
        const res = await fetch("/api/champions");
        const text = await res.text();
        write(`Status: ${res.status}\nBody: ${text.slice(0, 500)}${text.length > 500 ? "..." : ""}`);
      } catch (err) {
        write(`Erreur champions: ${err}`);
      }
    };
  }

  const btnSplash = document.getElementById("test-splash");
  if (btnSplash) {
    btnSplash.onclick = async () => {
      write("Appel /api/splash?champ=Aatrox&skin=1 ...");
      try {
        const res = await fetch("/api/splash?champ=Aatrox&skin=1");
        write(`Status: ${res.status}\nContent-Type: ${res.headers.get("content-type")}`);
      } catch (err) {
        write(`Erreur splash: ${err}`);
      }
    };
  }

  const btnCurrentChampion = document.getElementById("test-current-champion");
  if (btnCurrentChampion) {
    btnCurrentChampion.onclick = () => {
      const info = getDebugInfo();
      write(JSON.stringify(info, null, 2));
    };
  }
}

navigate("home");
