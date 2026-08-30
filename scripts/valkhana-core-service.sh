#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 {install|update|verify|uninstall}" >&2
  exit 2
}

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
action=${1:-}
case "$action" in
  install|update|verify|uninstall) ;;
  *) usage ;;
esac

manager_home=$(systemctl --user show-environment 2>/dev/null | sed -n 's/^HOME=//p' | head -1)
manager_home=${manager_home:-$HOME}
case "$manager_home" in
  /*) ;;
  *) echo "Refusing non-absolute user-manager HOME: $manager_home" >&2; exit 1 ;;
esac

unit_dir="$manager_home/.config/systemd/user"
unit_path="$unit_dir/valkhana-core.service"
install_root="$manager_home/.local"
socket_path="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}/valkhana/core.sock"

verify() {
  systemctl --user is-enabled valkhana-core.service >/dev/null
  systemctl --user is-active valkhana-core.service >/dev/null

  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    if [[ -S "$socket_path" ]] && curl --fail --silent --show-error \
      --unix-socket "$socket_path" http://localhost/v1/health; then
      echo
      return 0
    fi
    sleep 0.2
  done

  echo "ValKhana core did not become healthy at $socket_path" >&2
  systemctl --user --no-pager --full status valkhana-core.service >&2 || true
  return 1
}

install_service() {
  command -v cargo >/dev/null || { echo "cargo is required" >&2; exit 1; }
  command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

  cargo install --path "$repo_root/crates/valkhana-core" --root "$install_root" --locked --force
  install -d -m 0755 "$unit_dir"
  install -m 0644 "$repo_root/systemd/valkhana-core.service" "$unit_path"
  systemctl --user daemon-reload
  XDG_CONFIG_HOME="$manager_home/.config" systemctl --user enable valkhana-core.service
  systemctl --user reset-failed valkhana-core.service 2>/dev/null || true
  systemctl --user restart valkhana-core.service
  verify
}

case "$action" in
  install|update)
    install_service
    ;;
  verify)
    verify
    ;;
  uninstall)
    systemctl --user disable --now valkhana-core.service 2>/dev/null || true
    if [[ -e "$unit_path" ]]; then
      unlink "$unit_path"
    fi
    if [[ -e "$install_root/bin/valkhana-core" ]]; then
      unlink "$install_root/bin/valkhana-core"
    fi
    systemctl --user daemon-reload
    echo "ValKhana core service and installed binary removed. Repository files were preserved."
    ;;
esac
