#!/usr/bin/env python3
"""
abs_bridge.py — Puente Serial → WebSocket con registro de fallos en SQLite
---------------------------------------------------------------------------
Lee JSON del Arduino MEGA, retransmite por WebSocket y guarda fallos en BD.
"""
# 
import asyncio
import json
import argparse
import logging
import sqlite3
import threading
import serial
import serial.tools.list_ports
import websockets
from websockets.server import serve
from datetime import datetime
from pathlib import Path
from typing import Optional  # FIX #2: compatible con Python 3.8/3.9

# ── Logging ────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("abs_bridge")

# ── Base de datos SQLite ───────────────────────────────────
DB_PATH = Path(__file__).parent / "faults.db"

# FIX #3: Lock para acceso seguro a SQLite desde múltiples contextos
_db_lock = threading.Lock()

def init_db():
    """Crea la tabla de fallos si no existe."""
    with _db_lock:
        # FIX #3: check_same_thread=False para uso seguro entre hilo serial y asyncio
        with sqlite3.connect(DB_PATH, check_same_thread=False) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS faults (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    sensor_id INTEGER NOT NULL,
                    sensor_name TEXT,
                    from_state TEXT,
                    to_state TEXT
                )
            """)
    log.info(f"Base de datos inicializada en {DB_PATH}")

def save_fault(sensor_id: int, sensor_name: str, from_state: str, to_state: str):
    """Inserta un nuevo registro de falla en la BD."""
    timestamp = datetime.now().isoformat(timespec="seconds")
    with _db_lock:
        with sqlite3.connect(DB_PATH, check_same_thread=False) as conn:
            conn.execute(
                "INSERT INTO faults (timestamp, sensor_id, sensor_name, from_state, to_state) VALUES (?, ?, ?, ?, ?)",
                (timestamp, sensor_id, sensor_name, from_state, to_state)
            )
    log.info(f"Falla registrada: Sensor {sensor_id} ({sensor_name}) → {to_state}")

def get_fault_history(limit: int = 100):
    """Recupera los últimos 'limit' fallos ordenados por timestamp descendente."""
    with _db_lock:
        with sqlite3.connect(DB_PATH, check_same_thread=False) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM faults ORDER BY timestamp DESC LIMIT ?",
                (limit,)
            )
            return [dict(row) for row in cursor.fetchall()]

# ── Estado global ───────────────────────────────────────────
connected_clients: set = set()
latest_data: dict = {}
sensor_history: list = []
MAX_HISTORY = 300

# Mapeo de nombres de sensores (se actualizará desde el JSON)
sensor_names = ["FL", "FR", "RL", "RR"]  # nombres por defecto

# ── Auto-detección del puerto ──────────────────────────────
# FIX #2: Usar Optional[str] en lugar de str | None para compatibilidad Python 3.8+
def find_arduino_port() -> Optional[str]:
    ports = serial.tools.list_ports.comports()
    for p in ports:
        desc = (p.description or "").lower()
        if any(k in desc for k in ["arduino", "mega", "ch340", "ch341", "cp210", "ftdi", "usb serial"]):
            log.info(f"Arduino detectado: {p.device} ({p.description})")
            return p.device
    if ports:
        log.warning(f"No se identificó Arduino; usando primer puerto: {ports[0].device}")
        return ports[0].device
    return None

# ── Lectura Serial ──────────────────────────────────────────
def read_serial_sync(port: str, baud: int, queue: asyncio.Queue, loop: asyncio.AbstractEventLoop):
    try:
        ser = serial.Serial(port, baud, timeout=2)
        log.info(f"Puerto serie abierto: {port} @ {baud} baud")
    except serial.SerialException as e:
        log.error(f"No se pudo abrir {port}: {e}")
        # FIX #4: Señalizar al broadcaster que el hilo terminó con centinela
        asyncio.run_coroutine_threadsafe(queue.put(None), loop)
        return

    while True:
        try:
            line = ser.readline().decode("utf-8", errors="replace").strip()
            if not line:
                continue
            if not line.startswith("{"):
                log.debug(f"Línea no-JSON ignorada: {line[:60]}")
                continue
            data = json.loads(line)
            data["host_ts"] = datetime.now().isoformat(timespec="milliseconds")
            asyncio.run_coroutine_threadsafe(queue.put(data), loop)
        except json.JSONDecodeError as e:
            log.debug(f"JSON inválido: {e} → '{line[:80]}'")
        except serial.SerialException as e:
            log.error(f"Error serial: {e}")
            # FIX #4: Señalizar al broadcaster que el hilo terminó con centinela
            asyncio.run_coroutine_threadsafe(queue.put(None), loop)
            break
        except Exception as e:
            log.error(f"Error inesperado en lectura serie: {e}")

# ── Broadcaster con detección de fallos ────────────────────
async def broadcaster(queue: asyncio.Queue):
    global latest_data, sensor_history, sensor_names
    prev_states = [None, None, None, None]  # para detectar transiciones

    while True:
        data = await queue.get()

        # FIX #4: Manejar el centinela None que indica fin del hilo serial
        if data is None:
            log.error("El hilo serial terminó inesperadamente. El broadcaster se detiene.")
            # Notificar a los clientes conectados
            if connected_clients:
                msg = json.dumps({"type": "error", "message": "Conexión serial perdida"})
                # FIX #5: Iterar sobre una copia para evitar mutación durante iteración
                for ws in list(connected_clients):
                    try:
                        await ws.send(msg)
                    except websockets.exceptions.ConnectionClosed:
                        connected_clients.discard(ws)
            return

        latest_data = data
        sensor_history.append(data)
        if len(sensor_history) > MAX_HISTORY:
            sensor_history.pop(0)

        # Actualizar nombres de sensores si vienen en el JSON
        if "names" in data:
            sensor_names = data["names"]

        # Detectar cambios de estado y fallos
        if "s" in data:
            for s in data["s"]:
                sid = s.get("id")
                if sid is None or sid >= len(prev_states):
                    continue
                new_state = s.get("nombre")
                old_state = prev_states[sid]
                if old_state is not None and old_state != new_state:
                    # Si el nuevo estado es FALLA, guardar en BD
                    if new_state == "FALLA":
                        name = sensor_names[sid] if sid < len(sensor_names) else f"Sensor {sid+1}"
                        save_fault(sid, name, old_state, new_state)
                prev_states[sid] = new_state

        if connected_clients:
            message = json.dumps(data)
            dead = set()
            # FIX #5: Iterar sobre una copia del set para evitar RuntimeError por mutación concurrente
            for ws in list(connected_clients):
                try:
                    await ws.send(message)
                except websockets.exceptions.ConnectionClosed:
                    dead.add(ws)
            connected_clients -= dead

# ── WebSocket Handler ───────────────────────────────────────
async def ws_handler(websocket):
    client_ip = websocket.remote_address
    log.info(f"Cliente conectado: {client_ip}")
    connected_clients.add(websocket)

    try:
        # Enviar estado actual
        if latest_data:
            await websocket.send(json.dumps(latest_data))
        # Enviar historial reciente
        if sensor_history:
            await websocket.send(json.dumps({
                "type": "history",
                "data": sensor_history[-50:]
            }))
        # Enviar historial de fallos desde BD
        faults = get_fault_history(limit=100)
        if faults:
            await websocket.send(json.dumps({
                "type": "fault_history",
                "data": faults
            }))

        # Mantener conexión y escuchar mensajes entrantes
        async for _ in websocket:
            pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        # FIX #5: discard es seguro pero puede correr durante iteración en broadcaster;
        # la copia list() en broadcaster ya lo protege del lado del emisor
        connected_clients.discard(websocket)
        log.info(f"Cliente desconectado: {client_ip}")

# ── Main ────────────────────────────────────────────────────
async def main(serial_port: str, baud: int, ws_host: str, ws_port: int):
    init_db()
    queue: asyncio.Queue = asyncio.Queue(maxsize=500)
    # FIX #1: Usar get_running_loop() dentro de un contexto async, no get_event_loop()
    loop = asyncio.get_running_loop()

    t = threading.Thread(
        target=read_serial_sync,
        args=(serial_port, baud, queue, loop),
        daemon=True
    )
    t.start()

    log.info(f"WebSocket server escuchando en ws://{ws_host}:{ws_port}")
    async with serve(ws_handler, ws_host, ws_port):
        # FIX #1: Usar asyncio.Future() directamente, no a través de get_event_loop()
        await asyncio.gather(
            broadcaster(queue),
            loop.create_future()  # Mantiene el servidor corriendo indefinidamente
        )

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ABS Monitor — Puente Serial/WebSocket con BD")
    parser.add_argument("--port",    default=None,    help="Puerto serie del Arduino")
    parser.add_argument("--baud",    default=115200,  type=int, help="Velocidad baud")
    parser.add_argument("--ws-host", default="0.0.0.0", help="Host WebSocket")
    parser.add_argument("--ws-port", default=8765,   type=int, help="Puerto WebSocket")
    args = parser.parse_args()

    serial_port = args.port or find_arduino_port()
    if not serial_port:
        log.error("No se encontró ningún puerto serie. Usa --port para especificarlo.")
        exit(1)

    try:
        asyncio.run(main(serial_port, args.baud, args.ws_host, args.ws_port))
    except KeyboardInterrupt:
        log.info("Servidor detenido por el usuario.")