"""Owner-installed DCS launcher for Raiker's workspace-relative Python template.

Copy to .raiker/mcp/servers/dcs.py in your Raiker workspace after creating the
local Python example named dcs. Install the DCS tarball under tools/dcs first.
This replaces the example with custom code; review it before testing the server.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys

package = Path.cwd() / "tools/dcs/node_modules/dcs-sortie-mcp"
entry = package / "dist/index.js"
node = shutil.which("node")
if not node or not entry.is_file():
    sys.exit("Install Node 20+ and install the DCS package under tools/dcs in this workspace; see docs/user/clients.md#raiker.")
tools = json.loads((package / "examples/clients/raiker-tools.json").read_text(encoding="utf-8"))
# Raiker sends a bounded batch then closes stdin. Negotiate a revision shared by
# its connector and the bundled SDK. All other fields and responses pass through.
messages = []
for line in sys.stdin.buffer:
    message = json.loads(line)
    if message.get("method") == "initialize":
        message["params"]["protocolVersion"] = "2025-06-18"
    messages.append(json.dumps(message).encode("utf-8") + b"\n")
result = subprocess.run(
    [node, str(entry), "--tools", ",".join(tools)],
    input=b"".join(messages), stdout=sys.stdout.buffer, stderr=sys.stderr.buffer,
    check=False,
)
sys.exit(result.returncode)
