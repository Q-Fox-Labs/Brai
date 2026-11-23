#!/usr/bin/env bash
# ABOUTME: Запускает штатный клиентский Ansible и проверяет локальную готовность Brai.
# ABOUTME: Хранит тестовые входы и полные журналы только на одноразовом раннере.
set -euo pipefail
umask 077

[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
installer=$(realpath "$1")
fixture=$(realpath "$(dirname "$0")/client-install-fixture.py")
run_dir=$(mktemp -d "$RUNNER_TEMP/brai-client-install.XXXXXXXX")

sample_disk() {
  local directory paths=(/ "$RUNNER_TEMP" /srv /var/lib)
  for directory in /var/lib/docker /var/lib/containerd; do
    if [[ -d "$directory" ]]; then
      paths+=("$directory")
    fi
  done
  df -B1 --output=target,avail "${paths[@]}" | tail -n +2 | sort -u
}

report() {
  local code=$?
  local last_task chrome_root chrome_archive sha
  trap - EXIT
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  { cat "$run_dir/disk"; sample_disk || true; } | awk '
    !($1 in start) { start[$1] = min[$1] = $2 }
    $2 < min[$1] { min[$1] = $2 }
    END {
      for (mount in start)
        printf "%s: start free %.2f GiB, lowest sampled free %.2f GiB, sampled increase %.2f GiB\n", mount, start[mount] / 2^30, min[mount] / 2^30, (start[mount] - min[mount]) / 2^30
    }'
  if ((code)); then
    if [[ -f "$run_dir/ansible.log" ]]; then
      last_task=$(awk '/^TASK \[/ { last = $0 } END { print last }' "$run_dir/ansible.log")
      if [[ -n "$last_task" ]]; then
        printf 'Last Ansible task: %s\n' "$last_task"
      fi
      if [[ "$last_task" == *'Verify archive and all installed Chrome bytes'* ]]; then
        for chrome_root in /opt/brai-hermes-browser/chrome-linux64 /opt/agent-browser-tools/chrome/154.0.8037.92/chrome-linux64; do
          if [[ -d "$chrome_root" ]]; then
            chrome_archive=/var/cache/brai-hermes-chrome-154.0.8037.92.zip
            sha=$(printf '%s' "$chrome_root" | sha256sum | cut -d' ' -f1)
            sudo namei -l "$chrome_root" "$chrome_archive" /etc/brai-hermes/chrome-catalog || true
            sudo /usr/bin/python3 -B /usr/local/lib/brai-hermes/native_chrome.py \
              --root "$chrome_root" --archive "$chrome_archive" \
              --receipt "/etc/brai-hermes/chrome-catalog/$sha.json" || true
          fi
        done
      fi
    fi
    sudo docker ps -a --format '{{.Names}}  {{.Status}}' 2>/dev/null || true
  fi
  rm -rf -- "$run_dir"
  exit "$code"
}

sample_disk > "$run_dir/disk"
(while sleep 5; do sample_disk >> "$run_dir/disk"; done) &
sampler=$!
trap report EXIT

python3 -B "$fixture" unpack "$BRAI_CI_SOURCE_SHA" "$run_dir/inputs.yml"
unset BRAI_CI_INSTALL_BUNDLE BRAI_CI_HF_TOKEN BRAI_CI_MEMOS_SDK_URL BRAI_CI_RELEASE_PACKAGES_URL
unset BRAI_CI_REGISTRY_TOKEN CI_PACKAGES_TOKEN BRAI_CI_ARCHIVE_PASSPHRASE BRAI_CI_TELEGRAM_BOT_TOKEN
if [[ -f "$run_dir/release-oci.tar" ]]; then
  sudo --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT /usr/bin/python3 -B \
    "$(dirname "$fixture")/stage-release-packages.py" "$run_dir/release-oci.tar" \
    "$run_dir/release-manifest.json" "$installer/ansible/client/roles/brai_install/files/install_server.py"
  rm -- "$run_dir/release-oci.tar" "$run_dir/release-manifest.json"
fi
printf '[managed]\nlocalhost ansible_connection=local ansible_python_interpreter=/usr/bin/python3\n' > "$run_dir/hosts.ini"

cd "$installer/ansible"
printf 'Running client install from Admin %s\n' "$(git rev-parse HEAD)"
ansible_playbook=$(command -v ansible-playbook)
sudo -n /bin/bash -c '
  umask 022
  export ANSIBLE_NOCOLOR=1 ANSIBLE_NO_LOG=true
  exec "$@"
' bash "$ansible_playbook" -i "$run_dir/hosts.ini" client/install.yml \
  --extra-vars "@$run_dir/inputs.yml" > "$run_dir/ansible.log" 2>&1

sudo test -f /var/lib/brai-install/completed.json
printf 'Checking the installed Brai revision, containers, systemd services and the local Web endpoint\n'
installed_sha=$(git -c safe.directory=/srv/projects/brai -C /srv/projects/brai rev-parse HEAD)
if [[ "$installed_sha" != "$BRAI_CI_SOURCE_SHA" ]]; then
  echo 'Installed Brai revision differs from the requested candidate.' >&2
  exit 1
fi
sudo /usr/bin/python3 -B /var/lib/brai-install/install_server.py verify \
  --manifest /var/lib/brai-install/baseline.json --inputs /var/lib/brai-install/inputs.json \
  > "$run_dir/verify.log" 2>&1
sudo docker compose --project-name brai --file /var/lib/brai-install/projects/brai.json exec -T web \
  node -e '
    (async () => {
      const response = await fetch("http://127.0.0.1:3000/api/health", {signal: AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error("Web health check failed");
      const health = await response.json();
      if (health.component !== "web" || health.ready !== true) throw new Error("Web is not ready");
    })().catch(() => { process.exitCode = 1; });
  '
echo 'Client install and local Web startup verified.'
