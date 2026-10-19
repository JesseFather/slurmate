# Copyright 2026 JesseFather
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# 测试夹具的作业侧。
#
# 它起一个最小的 HTTP 服务，`/healthz` 与界面路径都返回 200。客户端测试会把它
#   换成一份 node 实现（见 `boot.test.mjs` 的 `buildFixtureSiteTree`），集群测试
#   直接跑这一份。
#
# 遵守作业侧的硬规矩：成功时写 $SVC_PID、不重定向输出、服务起来之后再返回。
#   探活绑 127.0.0.1 而不是 $NODE_IP：测试里的节点地址是文档地址，本机绑不上。

start_web_demo() {
    local p="$1" i
    python3 - "$p" <<'PY' &
import http.server, socketserver, sys

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('0.0.0.0', int(sys.argv[1])), H) as s:
    s.serve_forever()
PY
    SVC_PID=$!
    for i in $(seq 1 50); do
        kill -0 "$SVC_PID" 2>/dev/null || { SVC_PID=""; return 1; }
        if curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:${p}/healthz" 2>/dev/null; then
            return 0
        fi
        sleep 0.1
    done
    log "夹具的服务 5 秒没有就绪"
    kill -TERM "$SVC_PID" 2>/dev/null || true
    sleep 0.2
    kill -KILL "$SVC_PID" 2>/dev/null || true
    SVC_PID=""
    return 1
}
