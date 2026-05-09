const WS_DEFAULT = "ws://localhost:8765";
let ws = null;
let sensorNames = [
  "Sensor FL (Del. Izq.)",
  "Sensor FR (Del. Der.)",
  "Sensor RL (Tras. Izq.)",
  "Sensor RR (Tras. Der.)"
];
let prevStates = [null, null, null, null];
const diagLog = [];
const POS_TAG = ["FL", "FR", "RL", "RR"];

// ── Navegación entre pestañas ────────────────────────────────────────────────
document.querySelectorAll(".nav-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("page-" + tab.dataset.page).classList.add("active");
  });
});

// ── Reloj ────────────────────────────────────────────────────────────────────
setInterval(() => {
  document.getElementById("clock").textContent =
    new Date().toLocaleTimeString("es-MX", { hour12: false });
}, 1000);

// ── Conversión ADC → cm ──────────────────────────────────────────────────────
function adcToCm(adc) {
  if (adc < 20) return 80;
  const v = (adc / 1023) * 5.0;
  if (v <= 0.42) return 80;
  return Math.max(10, Math.min(80, 27.86 / (v - 0.42)));
}

// ── Creación inicial de las tarjetas de sensor ───────────────────────────────
function initSensorCards() {
  const grid = document.getElementById("sensors-grid");
  grid.innerHTML = [0, 1, 2, 3].map(i => `
    <div class="sensor-card" id="card-${i}">
      <div class="wheel-icon">
        <svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg" id="wheel-${i}">
          <circle cx="25" cy="25" r="22" fill="none" stroke="#2a3545" stroke-width="3"/>
          <circle cx="25" cy="25" r="8"  fill="none" stroke="#2a3545" stroke-width="2"/>
          <line x1="25" y1="3"  x2="25" y2="17" stroke="#2a3545" stroke-width="2"/>
          <line x1="25" y1="33" x2="25" y2="47" stroke="#2a3545" stroke-width="2"/>
          <line x1="3"  y1="25" x2="17" y2="25" stroke="#2a3545" stroke-width="2"/>
          <line x1="33" y1="25" x2="47" y2="25" stroke="#2a3545" stroke-width="2"/>
          <line x1="9"  y1="9"  x2="19" y2="19" stroke="#2a3545" stroke-width="2"/>
          <line x1="31" y1="31" x2="41" y2="41" stroke="#2a3545" stroke-width="2"/>
          <line x1="41" y1="9"  x2="31" y2="19" stroke="#2a3545" stroke-width="2"/>
          <line x1="19" y1="31" x2="9"  y2="41" stroke="#2a3545" stroke-width="2"/>
        </svg>
      </div>
      <div class="sensor-header">
        <div>
          <div class="sensor-id">SENSOR ${i + 1} — ${POS_TAG[i]}</div>
          <div class="sensor-name" id="sname-${i}">${sensorNames[i]}</div>
        </div>
        <div class="sensor-badge badge-iniciando" id="badge-${i}">INICIANDO</div>
      </div>
      <div class="sensor-gauge"><div class="gauge-fill" id="gauge-${i}" style="width:0%"></div></div>
      <div class="sensor-metrics">
        <div class="metric"><div class="metric-label">ADC Raw</div><div class="metric-value" id="adc-${i}">—</div></div>
        <div class="metric"><div class="metric-label">Voltaje</div><div class="metric-value" id="volt-${i}">— V</div></div>
        <div class="metric"><div class="metric-label">Dist. aprox.</div><div class="metric-value" id="dist-${i}">— cm</div></div>
        <div class="metric"><div class="metric-label">Baseline</div><div class="metric-value" id="base-${i}">—</div></div>
      </div>
    </div>
  `).join("");
}

// ── Mapa de colores por estado ───────────────────────────────────────────────
const STATE_COLOR = {
  GIRANDO:   "var(--ok)",
  PLANO:     "var(--warn)",
  FALLA:     "var(--fail)",
  INICIANDO: "var(--neutral)"
};

// ── Actualizar una tarjeta de sensor ─────────────────────────────────────────
function updateCard(s) {
  const { id, adc, nombre, cal, base } = s;
  const volt  = ((adc / 1023) * 5.0).toFixed(3);
  const dist  = adcToCm(adc).toFixed(1);
  const pct   = (adc / 1023 * 100).toFixed(1);
  const card  = document.getElementById("card-"  + id);
  const badge = document.getElementById("badge-" + id);
  const wheel = document.getElementById("wheel-" + id);
  const gauge = document.getElementById("gauge-" + id);

  card.className  = "sensor-card estado-" + nombre.toLowerCase();
  badge.className = "sensor-badge badge-" + nombre.toLowerCase();
  badge.textContent = nombre === "GIRANDO" ? "GIRANDO ●" : nombre;

  gauge.style.width      = pct + "%";
  gauge.style.background = STATE_COLOR[nombre] || "var(--neutral)";

  document.getElementById("adc-"  + id).textContent = adc;
  document.getElementById("volt-" + id).textContent = volt + " V";
  document.getElementById("dist-" + id).textContent = dist + " cm";
  document.getElementById("base-" + id).textContent = cal ? base : "Cal...";

  const c = STATE_COLOR[nombre] || "#2a3545";
  wheel.querySelectorAll("circle,line").forEach(el => el.setAttribute("stroke", c));

  if      (nombre === "GIRANDO") wheel.style.animation = "spin 0.8s linear infinite";
  else if (nombre === "PLANO")   wheel.style.animation = "spin 4s linear infinite";
  else                           wheel.style.animation = "none";

  if (prevStates[id] !== null && prevStates[id] !== nombre) {
    logEvent(id, prevStates[id], nombre);
  }
  prevStates[id] = nombre;
}

// ── Log de eventos ────────────────────────────────────────────────────────────
function logEvent(id, from, to) {
  const time = new Date().toLocaleTimeString("es-MX", { hour12: false });
  const msg  = `S${id + 1} [${sensorNames[id]}]: ${from} → ${to}`;
  const cls  = to === "FALLA" ? "log-fail" : to === "PLANO" ? "log-warn" : "log-ok";

  const log = document.getElementById("event-log");
  const e   = document.createElement("div");
  e.className = "log-entry " + cls;
  e.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${msg}</span>`;
  log.insertBefore(e, log.firstChild);
  if (log.children.length > 60) log.removeChild(log.lastChild);

  diagLog.unshift({ time, msg, cls });
  document.getElementById("diag-log").innerHTML = diagLog
    .map(ev => `<div class="log-entry ${ev.cls}"><span class="log-time">${ev.time}</span><span class="log-msg">${ev.msg}</span></div>`)
    .join("");
}

// ── Tabla RAW ─────────────────────────────────────────────────────────────────
function updateRawTable(sensors) {
  const BADGE_CLS = {
    GIRANDO:   "badge-girando",
    PLANO:     "badge-plano",
    FALLA:     "badge-falla",
    INICIANDO: "badge-iniciando"
  };
  document.getElementById("raw-tbody").innerHTML = sensors.map(s => {
    const v   = ((s.adc / 1023) * 5.0).toFixed(3);
    const d   = adcToCm(s.adc).toFixed(1);
    const cls = BADGE_CLS[s.nombre];
    return `<tr>
      <td>${sensorNames[s.id]}</td>
      <td>${s.adc}</td>
      <td>${v} V</td>
      <td>${d} cm</td>
      <td><span class="sensor-badge ${cls}">${s.nombre}</span></td>
      <td>${s.cal ? s.base : "—"}</td>
    </tr>`;
  }).join("");
}

// ── Resumen del sistema ───────────────────────────────────────────────────────
function updateSummary(sensors) {
  const c = { GIRANDO: 0, PLANO: 0, FALLA: 0, INICIANDO: 0 };
  sensors.forEach(s => { c[s.nombre] = (c[s.nombre] || 0) + 1; });
  document.getElementById("count-girando").textContent = c.GIRANDO;
  document.getElementById("count-plano").textContent   = c.PLANO;
  document.getElementById("count-falla").textContent   = c.FALLA;
  document.getElementById("count-init").textContent    = c.INICIANDO;
}

// ── Historial de fallos ───────────────────────────────────────────────────────
function displayFaultHistory(faults) {
  const tbody = document.getElementById("faults-tbody");
  if (!faults || faults.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="color:var(--text);text-align:center">No hay fallos registrados</td></tr>`;
    return;
  }
  tbody.innerHTML = faults.map(f => {
    const date = new Date(f.timestamp).toLocaleString("es-MX");
    return `<tr>
      <td>${date}</td>
      <td>${f.sensor_name || `Sensor ${f.sensor_id + 1}`}</td>
      <td><span style="color:var(--warn)">${f.from_state}</span> → <span style="color:var(--fail)">${f.to_state}</span></td>
    </tr>`;
  }).join("");
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS(url) {
  if (ws) { ws.close(); ws = null; }
  try { ws = new WebSocket(url); } catch (e) { setWSStatus(false); return; }

  ws.onopen = () => {
    setWSStatus(true);
    const log = document.getElementById("event-log");
    const e   = document.createElement("div");
    e.className = "log-entry log-ok";
    e.innerHTML = `<span class="log-time">${new Date().toLocaleTimeString("es-MX", { hour12: false })}</span><span class="log-msg">Conectado a ${url}</span>`;
    log.insertBefore(e, log.firstChild);
  };

  ws.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.type === "history") return;
      if (data.type === "fault_history") { displayFaultHistory(data.data); return; }
      if (!data.s) return;
      data.s.forEach(s => updateCard(s));
      updateSummary(data.s);
      updateRawTable(data.s);
    } catch (e) { console.warn(e); }
  };

  ws.onclose = () => setWSStatus(false);
  ws.onerror = () => setWSStatus(false);
}

function setWSStatus(ok) {
  document.getElementById("ws-dot").className   = "status-dot" + (ok ? " connected" : "");
  document.getElementById("ws-label").textContent = ok ? "EN LÍNEA" : "DESCONECTADO";
}

// ── Formulario de nombres de sensores ─────────────────────────────────────────
function initNamesForm() {
  document.getElementById("sensor-names-form").innerHTML = sensorNames.map((n, i) => `
    <div>
      <div style="font-family:var(--font-mono);font-size:0.65rem;color:var(--text);margin-bottom:0.3rem;letter-spacing:0.1em">
        SENSOR ${i + 1} (${POS_TAG[i]})
      </div>
      <input id="name-input-${i}" type="text" value="${n}"
        style="background:var(--wt);border:1px solid var(--bg);border-radius:3px;color:var(--bg);font-size:1rem;padding:0.5rem 0.7rem;width:100%"/>
    </div>
  `).join("");
}

// ── Event listeners de botones ────────────────────────────────────────────────
document.getElementById("btn-connect").addEventListener("click", () => {
  connectWS(document.getElementById("ws-url-input").value.trim() || WS_DEFAULT);
});

document.getElementById("btn-disconnect").addEventListener("click", () => {
  if (ws) { ws.close(); ws = null; }
  setWSStatus(false);
});

document.getElementById("btn-save-names").addEventListener("click", () => {
  for (let i = 0; i < 4; i++) {
    const v = document.getElementById("name-input-" + i).value.trim();
    if (v) {
      sensorNames[i] = v;
      document.getElementById("sname-" + i).textContent = v;
    }
  }
});

// ── Inicialización ────────────────────────────────────────────────────────────
initSensorCards();
initNamesForm();
connectWS(WS_DEFAULT);
