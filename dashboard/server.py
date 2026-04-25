#!/usr/bin/env python3
"""seamless-wan dashboard — lightweight web UI for OpenMPTCProuter management.

Runs in the Alpine Linux chroot, communicates with the OMR host via SSH.
Usage: python3 server.py [--port 8080]
"""

import json
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

import auth
import host_commands
from models import api_success, api_error

PORT = int(os.environ.get("DASHBOARD_PORT", "8080"))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
}


class DashboardHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the dashboard API and static files."""

    def log_message(self, format, *args):
        """Override to use simpler logging."""
        sys.stderr.write(f"[dashboard] {args[0]} {args[1]} {args[2]}\n")

    # --- Response helpers ---

    def send_json(self, body: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def send_static(self, filepath: str) -> None:
        """Serve a static file."""
        # Prevent directory traversal
        realpath = os.path.realpath(filepath)
        if not realpath.startswith(os.path.realpath(STATIC_DIR)):
            self.send_json(api_error("Forbidden", 403), 403)
            return

        if not os.path.isfile(realpath):
            self.send_json(api_error("Not found", 404), 404)
            return

        ext = os.path.splitext(realpath)[1]
        content_type = MIME_TYPES.get(ext, "application/octet-stream")

        with open(realpath, "rb") as f:
            content = f.read()

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        if ext in (".css", ".js"):
            self.send_header("Cache-Control", "public, max-age=300")
        self.end_headers()
        self.wfile.write(content)

    def read_json_body(self) -> dict | None:
        """Read and parse JSON request body."""
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            return None

    def require_auth(self) -> bool:
        """Check authentication. Returns True if authorized."""
        headers = {k: v for k, v in self.headers.items()}
        if auth.check_request_auth(headers):
            return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="seamless-wan"')
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(api_error("Unauthorized", 401).encode("utf-8"))
        return False

    # --- Route matching ---

    def _parse_path(self) -> tuple[str, list[str]]:
        """Parse URL path into (base, segments)."""
        parsed = urlparse(self.path)
        path = unquote(parsed.path).rstrip("/") or "/"
        segments = [s for s in path.split("/") if s]
        return path, segments

    # --- GET routes ---

    def do_GET(self) -> None:
        path, segments = self._parse_path()

        # Static files and root
        if path == "/" or path == "/index.html":
            self.send_static(os.path.join(STATIC_DIR, "index.html"))
            return

        if path.startswith("/static/"):
            rel = path[len("/static/"):]
            self.send_static(os.path.join(STATIC_DIR, rel))
            return

        # API routes require auth
        if not path.startswith("/api/"):
            self.send_json(api_error("Not found", 404), 404)
            return

        if not self.require_auth():
            return

        # GET /api/ping — lightweight session check (no SSH)
        if path == "/api/ping":
            self.send_json(api_success({"pong": True}))
            return

        # GET /api/status — cached 2s so concurrent clients don't hammer SSH
        if path == "/api/status":
            def _build():
                sys_status = host_commands.get_system_status()
                wans = host_commands.get_wan_status()
                tunnel = host_commands.get_tunnel_status()
                return {
                    "system": sys_status.to_dict(),
                    "wans": [w.to_dict() for w in wans],
                    "tunnel": tunnel.to_dict(),
                }
            self.send_json(api_success(host_commands.cached("api_status", 2.0, _build)))
            return

        # GET /api/wan
        if path == "/api/wan":
            wans = host_commands.get_wan_status()
            self.send_json(api_success([w.to_dict() for w in wans]))
            return

        # GET /api/wan/public-ips — slow, call once
        if path == "/api/wan/public-ips":
            ips = host_commands.get_wan_public_ips()
            self.send_json(api_success(ips))
            return

        # GET /api/wan/probes — wan-monitor probe results (cached on host)
        if path == "/api/wan/probes":
            self.send_json(api_success(host_commands.get_wan_probes()))
            return

        # GET /api/roaming/status
        if path == "/api/roaming/status":
            status = host_commands.get_roaming_status()
            self.send_json(api_success(status.to_dict()))
            return

        # GET /api/roaming/networks
        if path == "/api/roaming/networks":
            networks = host_commands.get_known_networks()
            self.send_json(api_success([n.to_dict() for n in networks]))
            return

        # GET /api/tunnel
        if path == "/api/tunnel":
            tunnel = host_commands.get_tunnel_status()
            self.send_json(api_success(tunnel.to_dict()))
            return

        # GET /api/services
        if path == "/api/services":
            services = host_commands.get_services_status()
            self.send_json(api_success([s.to_dict() for s in services]))
            return

        self.send_json(api_error("Not found", 404), 404)

    # --- POST routes ---

    def do_POST(self) -> None:
        path, segments = self._parse_path()

        # POST /api/login — no auth required
        if path == "/api/login":
            body = self.read_json_body()
            if body is None:
                self.send_json(api_error("Invalid JSON", 400), 400)
                return
            username = body.get("username", "")
            password = body.get("password", "")
            import base64
            auth_header = "Basic " + base64.b64encode(
                f"{username}:{password}".encode()
            ).decode()
            if auth.check_basic_auth(auth_header):
                token = auth.create_session()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Set-Cookie", f"session={token}; Path=/; HttpOnly; SameSite=Strict")
                self.end_headers()
                self.wfile.write(api_success({"message": "Logged in"}).encode("utf-8"))
            else:
                self.send_json(api_error("Invalid credentials", 401), 401)
            return

        # All other POST routes require auth
        if not self.require_auth():
            return

        body = self.read_json_body()
        if body is None:
            self.send_json(api_error("Invalid JSON", 400), 400)
            return

        # POST /api/wan/<id>/restart
        if len(segments) == 4 and segments[0] == "api" and segments[1] == "wan" and segments[3] == "restart":
            wan_name = segments[2]
            result = host_commands.restart_wan(wan_name)
            if result.ok:
                self.send_json(api_success({"message": f"{wan_name} restarted"}))
            else:
                self.send_json(api_error(result.stderr or "Restart failed"), 500)
            return

        # POST /api/wan/captive — launch the captive-portal Firefox on the host
        if path == "/api/wan/captive":
            result = host_commands.trigger_captive_firefox()
            if result.ok:
                self.send_json(api_success({"message": "Captive Firefox launched"}))
            else:
                self.send_json(api_error(result.stderr or "Launch failed"), 500)
            return

        # POST /api/roaming/scan
        if path == "/api/roaming/scan":
            networks = host_commands.scan_wifi()
            self.send_json(api_success([n.to_dict() for n in networks]))
            return

        # POST /api/roaming/connect
        if path == "/api/roaming/connect":
            ssid = body.get("ssid", "")
            if not ssid:
                self.send_json(api_error("SSID is required", 400), 400)
                return
            result = host_commands.connect_wifi(ssid)
            if result.ok:
                self.send_json(api_success({"message": result.stdout or f"Connecting to {ssid}"}))
            else:
                self.send_json(api_error(result.stderr or "Connect failed"), 500)
            return

        # POST /api/roaming/disconnect
        if path == "/api/roaming/disconnect":
            result = host_commands.disconnect_wifi()
            if result.ok:
                self.send_json(api_success({"message": "Disconnected"}))
            else:
                self.send_json(api_error(result.stderr or "Disconnect failed"), 500)
            return

        # POST /api/roaming/networks
        if path == "/api/roaming/networks":
            ssid = body.get("ssid", "")
            key = body.get("key", "open")
            priority = body.get("priority", 10)
            autoconnect = body.get("autoconnect", True)
            try:
                priority = int(priority)
            except (ValueError, TypeError):
                self.send_json(api_error("Priority must be a number", 400), 400)
                return
            result = host_commands.add_known_network(ssid, key, priority, bool(autoconnect))
            if result.ok:
                self.send_json(api_success({"message": f"Added {ssid}"}), 201)
            else:
                self.send_json(api_error(result.stderr or "Add failed"), 400)
            return

        # POST /api/roaming/connect-and-add
        if path == "/api/roaming/connect-and-add":
            ssid = body.get("ssid", "")
            key = body.get("key", "open")
            priority = body.get("priority", 10)
            autoconnect = body.get("autoconnect", True)
            try:
                priority = int(priority)
            except (ValueError, TypeError):
                self.send_json(api_error("Priority must be a number", 400), 400)
                return
            result = host_commands.connect_and_add_network(ssid, key, priority, bool(autoconnect))
            if result.ok:
                self.send_json(api_success({"message": result.stdout}))
            else:
                self.send_json(api_error(result.stderr or "Connect+Add failed"), 500)
            return

        # POST /api/services/<name>/restart
        if len(segments) == 4 and segments[0] == "api" and segments[1] == "services" and segments[3] == "restart":
            service_name = segments[2]
            result = host_commands.restart_service(service_name)
            if result.ok:
                self.send_json(api_success({"message": f"{service_name} restarted"}))
            else:
                self.send_json(api_error(result.stderr or "Restart failed"), 500)
            return

        self.send_json(api_error("Not found", 404), 404)

    # --- PUT routes ---

    def do_PUT(self) -> None:
        path, segments = self._parse_path()

        if not self.require_auth():
            return

        body = self.read_json_body()
        if body is None:
            self.send_json(api_error("Invalid JSON", 400), 400)
            return

        # PUT /api/roaming/networks/<ssid>
        if len(segments) == 4 and segments[0] == "api" and segments[1] == "roaming" and segments[2] == "networks":
            ssid = unquote(segments[3])
            key = body.get("key", "open")
            priority = body.get("priority", 10)
            autoconnect = body.get("autoconnect", True)
            try:
                priority = int(priority)
            except (ValueError, TypeError):
                self.send_json(api_error("Priority must be a number", 400), 400)
                return
            result = host_commands.update_known_network(ssid, key, priority, bool(autoconnect))
            if result.ok:
                self.send_json(api_success({"message": f"Updated {ssid}"}))
            else:
                self.send_json(api_error(result.stderr or "Update failed"), 400)
            return

        self.send_json(api_error("Not found", 404), 404)

    # --- DELETE routes ---

    def do_DELETE(self) -> None:
        path, segments = self._parse_path()

        if not self.require_auth():
            return

        # DELETE /api/roaming/networks/<ssid>
        if len(segments) == 4 and segments[0] == "api" and segments[1] == "roaming" and segments[2] == "networks":
            ssid = unquote(segments[3])
            result = host_commands.delete_known_network(ssid)
            if result.ok:
                self.send_json(api_success({"message": f"Deleted {ssid}"}))
            else:
                self.send_json(api_error(result.stderr or "Delete failed"), 400)
            return

        self.send_json(api_error("Not found", 404), 404)


def main() -> None:
    port = PORT
    if len(sys.argv) > 1:
        for i, arg in enumerate(sys.argv[1:], 1):
            if arg == "--port" and i < len(sys.argv) - 1:
                port = int(sys.argv[i + 1])

    # Start background refreshers for slow data (public IP, etc.)
    host_commands.start_background_refreshers()

    # ThreadingHTTPServer so a slow request can't block the others
    server = ThreadingHTTPServer(("0.0.0.0", port), DashboardHandler)
    print(f"seamless-wan dashboard running on http://0.0.0.0:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
