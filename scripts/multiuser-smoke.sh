#!/usr/bin/env bash
set -Eeuo pipefail

image="${1:-docker.io/runzhliu/deepseek-harness:0.2.3-alpha.2-r1}"
expected_version="${2:-0.2.3-alpha.2}"
suffix="${RANDOM}-$$"
container="dsh-multiuser-smoke-${suffix}"
volume="dsh-multiuser-smoke-users-${suffix}"
public_host="chat.multiuser.test"
proxy_secret="0123456789abcdef0123456789abcdef"
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/dsh-multiuser-smoke.XXXXXX")"
alice_jar="${temporary_dir}/alice.cookies"
bob_jar="${temporary_dir}/bob.cookies"

cleanup() {
  docker container rm --force "${container}" >/dev/null 2>&1 || true
  docker volume rm "${volume}" >/dev/null 2>&1 || true
  rm -rf "${temporary_dir}"
}
trap cleanup EXIT INT TERM

actual_version="$(docker run --rm --entrypoint dsh "${image}" --version)"
if [[ "${actual_version}" != "${expected_version}" ]]; then
  echo "expected DSH ${expected_version}, got ${actual_version}" >&2
  exit 1
fi

docker volume create "${volume}" >/dev/null
docker run --detach --name "${container}" \
  --publish 127.0.0.1::8080 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  --shm-size 256m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 1024 \
  --memory 2g \
  --cpus 2 \
  --volume "${project_dir}/config/multiuser.example.json:/etc/dsh-multiuser/users.json:ro" \
  --volume "${project_dir}/providers/smoke.json:/tmp/providers-smoke.json:ro" \
  --volume "${volume}:/workspace" \
  --env DSH_MULTIUSER_CONFIG=/etc/dsh-multiuser/users.json \
  --env DSH_MULTIUSER_PUBLIC_SCHEME=http \
  --env "DSH_MULTIUSER_PUBLIC_HOST=${public_host}" \
  --env "DSH_MULTIUSER_PROXY_SECRET=${proxy_secret}" \
  --env DSH_MULTIUSER_PROXY_HEADER=X-DSH-Proxy-Secret \
  --env DSH_MULTIUSER_AUTH_HEADER=Remote-User \
  --env DSH_MULTIUSER_GROUPS_HEADER=Remote-Groups \
  --env DSH_MULTIUSER_LISTEN_PORT=8080 \
  --env DSH_MULTIUSER_USERS_ROOT=/workspace \
  --env DSH_MULTIUSER_PLUGIN_ROOT=/opt/deepseek-harness/plugins \
  --env DSH_MULTIUSER_WEB_PATCH=/opt/deepseek-harness/web.cordis.patch.yml \
  --env DSH_MULTIUSER_PATCH=/opt/deepseek-harness/web.multiuser.cordis.patch.yml \
  --env DSH_PROVIDERS_CONFIG=/tmp/providers-smoke.json \
  --env DSH_MULTIUSER_WORKSPACE_POLICY=restricted \
  --env DSH_MULTIUSER_WORKSPACE_PICKER=1 \
  --env DSH_MULTIUSER_WORKSPACE_POLICY_LOCK_DEFAULT=1 \
  --env DSH_MULTIUSER_WORKSPACE_POLICY_LOCK_ORDER=1 \
  --env DSH_MULTIUSER_HEAP_MB=256 \
  --env DSH_TELEMETRY_DISABLED=1 \
  --env DSH_DESKTOP_ENABLED=0 \
  --env DSH_BROWSER_USE_ENABLED=0 \
  --entrypoint /usr/bin/tini \
  "${image}" -- /usr/local/bin/node /opt/deepseek-harness/dsh-multiuser-supervisor.cjs >/dev/null

port="$(docker port "${container}" 8080/tcp | awk -F: 'NR == 1 { print $NF }')"

for attempt in $(seq 1 60); do
  if docker exec "${container}" node -e '
    fetch("http://127.0.0.1:8081/healthz")
      .then(response => response.json())
      .then(state => {
        if (!state.ok || !Array.isArray(state.users) || state.users.length !== 2) process.exit(1)
        if (!state.users.every(user => user.ready === true && user.error === null)) process.exit(1)
      })
      .catch(() => process.exit(1))
  '; then
    break
  fi
  if ! docker container inspect "${container}" >/dev/null 2>&1; then
    echo "container exited before the multiuser gateway became ready" >&2
    docker logs "${container}" >&2 || true
    exit 1
  fi
  sleep 1
done

if ! docker exec "${container}" node -e '
  fetch("http://127.0.0.1:8081/healthz")
    .then(response => response.json())
    .then(state => { if (!state.users.every(user => user.ready === true)) process.exit(1) })
    .catch(() => process.exit(1))
'; then
  echo "multiuser users did not become ready" >&2
  docker logs "${container}" >&2 || true
  exit 1
fi

request() {
  curl --silent --show-error \
    --header "Host: ${public_host}" \
    --header "X-DSH-Proxy-Secret: ${proxy_secret}" \
    --header "Remote-User: $1" \
    "http://127.0.0.1:${port}${2}"
}

status_code() {
  curl --silent --show-error \
    --header "Host: ${public_host}" \
    --header "X-DSH-Proxy-Secret: ${proxy_secret}" \
    --header "Remote-User: $1" \
    --output /dev/null --write-out '%{http_code}' \
    "http://127.0.0.1:${port}${2}"
}

echo "== authentication gates =="
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --header "Host: ${public_host}" --header 'Remote-User: alice' "http://127.0.0.1:${port}/")" == "403" ]] || { echo "missing proxy secret was not rejected" >&2; exit 1; }
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --header "Host: ${public_host}" --header "X-DSH-Proxy-Secret: ${proxy_secret}" "http://127.0.0.1:${port}/")" == "401" ]] || { echo "missing Remote-User was not rejected" >&2; exit 1; }
[[ "$(status_code carol /)" == "403" ]] || { echo "unknown Remote-User was not rejected" >&2; exit 1; }

echo "== same-URL login and per-user cookies =="
for user in alice bob; do
  if [[ "${user}" == alice ]]; then jar="${alice_jar}"; else jar="${bob_jar}"; fi
  status="$(curl --silent --show-error --location --max-redirs 5 \
    --cookie-jar "${jar}" --cookie "${jar}" \
    --header "Host: ${public_host}" \
    --header "X-DSH-Proxy-Secret: ${proxy_secret}" \
    --header "Remote-User: ${user}" \
    --output "${temporary_dir}/${user}.html" \
    --write-out '%{http_code}' \
    "http://127.0.0.1:${port}/")"
  [[ "${status}" == "200" ]] || { echo "${user} login failed with HTTP ${status}" >&2; exit 1; }
  grep --quiet '__DSH_BOOT__' "${temporary_dir}/${user}.html" || { echo "${user} did not receive the DSH app shell" >&2; exit 1; }
  grep --quiet "dsh-${user}-auth-" "${jar}" || { echo "${user} did not receive a user-scoped DSH cookie" >&2; exit 1; }
done

echo "== provider preset =="
docker exec "${container}" test -s /tmp/dsh-providers.cordis.patch.yml
docker exec "${container}" grep --quiet 'smoke-gateway' /tmp/dsh-providers.cordis.patch.yml

echo "== per-user directories and processes =="
for user in alice bob; do
  docker exec "${container}" test -d "/workspace/${user}/.dsh"
  docker exec "${container}" test -d "/workspace/${user}/workspaces"
  docker exec "${container}" test -d "/workspace/${user}/documents/deepseek-harness/default-workspace"
done
process_count="$(docker exec "${container}" ps -eo args | grep -c '[d]sh/lib/bin.js web')"
[[ "${process_count}" == "2" ]] || { echo "expected two DSH processes, got ${process_count}" >&2; exit 1; }
docker exec "${container}" test ! -e /tmp/dsh-desktop || { echo "desktop unexpectedly started in multiuser mode" >&2; exit 1; }

echo "== restricted directory picker =="
rpc() {
  local method="$1"
  local args="$2"
  local rpc_id
  rpc_id="$(cat /proc/sys/kernel/random/uuid)"
  curl --silent --show-error \
    --header "Host: ${public_host}" \
    --header "X-DSH-Proxy-Secret: ${proxy_secret}" \
    --header "Remote-User: alice" \
    --header 'content-type: application/json' \
    --cookie "${alice_jar}" \
    --request POST \
    --data "{\"type\":\"client-request\",\"rpcId\":\"${rpc_id}\",\"method\":\"${method}\",\"payload\":{\"args\":${args}}}" \
    "http://127.0.0.1:${port}/api/${method}"
}

picker_list="$(rpc directoryPicker/list '{"path":"/workspace/bob"}')"
node -e '
  const response = JSON.parse(process.argv[1])
  const value = response.result && response.result.value
  if (!value || value.path !== "/workspace/alice/workspaces") process.exit(1)
' "${picker_list}" || { echo "directory picker did not clamp to the user root" >&2; exit 1; }

picker_denied="$(rpc directoryPicker/createDirectory '{"path":"/workspace/bob","name":"new"}')"
node -e '
  const response = JSON.parse(process.argv[1])
  if (response.result && response.result.ok !== false) process.exit(1)
' "${picker_denied}" || { echo "directory picker allowed creation outside the user root" >&2; exit 1; }

picker_allowed="$(rpc directoryPicker/createDirectory '{"path":"/workspace/alice/workspaces","name":"new"}')"
node -e '
  const response = JSON.parse(process.argv[1])
  if (!response.result || !response.result.ok || response.result.value !== "/workspace/alice/workspaces/new") process.exit(1)
' "${picker_allowed}" || { echo "directory picker rejected an allowed creation" >&2; exit 1; }

echo "== workspace policy =="
docker exec "${container}" mkdir -p /workspace/alice/workspaces/sub1 /workspace/bob/workspaces/sub2
workspace_denied="$(rpc workspace/create '{"request":{"path":"/workspace/bob/workspaces/sub2"}}')"
node -e '
  const response = JSON.parse(process.argv[1])
  if (response.result && response.result.ok !== false) process.exit(1)
' "${workspace_denied}" || { echo "workspace policy allowed another user's directory" >&2; exit 1; }

workspace_allowed="$(rpc workspace/create '{"request":{"path":"/workspace/alice/workspaces/sub1"}}')"
node -e '
  const response = JSON.parse(process.argv[1])
  if (!response.result || !response.result.ok || response.result.value.created !== true) process.exit(1)
' "${workspace_allowed}" || { echo "workspace policy rejected an allowed sub-workspace" >&2; exit 1; }

default_workspace="$(rpc workspace/create '{"request":{"path":"/workspace/alice/documents/deepseek-harness/default-workspace"}}')"
default_id="$(node -e '
  const response = JSON.parse(process.argv[1])
  if (!response.result || !response.result.ok) process.exit(1)
  process.stdout.write(response.result.value.workspace.workspaceId)
' "${default_workspace}")"
default_rename="$(rpc workspace/rename "{\"request\":{\"workspaceId\":\"${default_id}\",\"title\":\"renamed\"}}")"
node -e '
  const response = JSON.parse(process.argv[1])
  if (response.result && response.result.ok !== false) process.exit(1)
' "${default_rename}" || { echo "workspace policy allowed renaming the default workspace" >&2; exit 1; }
default_delete="$(rpc workspace/delete "{\"request\":{\"workspaceId\":\"${default_id}\"}}")"
node -e '
  const response = JSON.parse(process.argv[1])
  if (response.result && response.result.ok !== false) process.exit(1)
' "${default_delete}" || { echo "workspace policy allowed deleting the default workspace" >&2; exit 1; }

echo "== token redaction and restart persistence =="
if docker logs "${container}" 2>&1 | grep -Eq 'token=[A-Za-z0-9_-]{30,}'; then
  echo "container logs contain a raw DSH launch token" >&2
  exit 1
fi
docker restart "${container}" >/dev/null
port="$(docker port "${container}" 8080/tcp | awk -F: 'NR == 1 { print $NF }')"
for attempt in $(seq 1 60); do
  if docker exec "${container}" node -e '
    fetch("http://127.0.0.1:8081/healthz")
      .then(response => response.json())
      .then(state => { if (!state.users.every(user => user.ready === true)) process.exit(1) })
      .catch(() => process.exit(1))
  '; then
    break
  fi
  sleep 1
done
status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --cookie "${alice_jar}" \
  --header "Host: ${public_host}" \
  --header "X-DSH-Proxy-Secret: ${proxy_secret}" \
  --header 'Remote-User: alice' \
  "http://127.0.0.1:${port}/")"
[[ "${status}" == "200" ]] || { echo "existing DSH cookie did not survive a restart (HTTP ${status})" >&2; exit 1; }

echo "multiuser smoke passed: one container, two users, same URL, per-user cookies, restricted picker/workspace, no raw token"
