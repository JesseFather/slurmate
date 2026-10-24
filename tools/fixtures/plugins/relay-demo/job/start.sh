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

# 测试夹具的作业侧：一个没有界面的中转服务。
#
# 两套件都不真的执行它 —— 假站点只跑有界面的作业侧（见 backend-fake.js 的
#   `_submit`），集群侧只把这段拼进作业脚本。它守的是形状：入口叫
#   start_relay_demo、成功时写 $SVC_PID、不重定向输出。

start_relay_demo() {
    local p="$1"
    "${SLURMATE_RELAY_DEMO_BIN:-/usr/sbin/relay-demo}" --port "$p" &
    SVC_PID=$!
    sleep 0.2
    kill -0 "$SVC_PID" 2>/dev/null || { SVC_PID=""; return 1; }
    return 0
}
