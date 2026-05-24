#!/bin/sh
set -e

REPO="dougwithseismic/hogsend"
BINARY="hogsend"
INSTALL_DIR="/usr/local/bin"

get_latest_version() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" |
    grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/'
}

detect_os() {
  case "$(uname -s)" in
    Darwin*)  echo "darwin" ;;
    Linux*)   echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unsupported" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "amd64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) echo "unsupported" ;;
  esac
}

main() {
  printf "\033[1;35m⬡ Hogsend CLI Installer\033[0m\n\n"

  OS=$(detect_os)
  ARCH=$(detect_arch)

  if [ "$OS" = "unsupported" ] || [ "$ARCH" = "unsupported" ]; then
    printf "\033[31mError: unsupported platform %s/%s\033[0m\n" "$(uname -s)" "$(uname -m)"
    exit 1
  fi

  VERSION="${HOGSEND_VERSION:-$(get_latest_version)}"
  if [ -z "$VERSION" ]; then
    printf "\033[31mError: could not determine latest version\033[0m\n"
    exit 1
  fi

  EXT="tar.gz"
  if [ "$OS" = "windows" ]; then
    EXT="zip"
  fi

  FILENAME="${BINARY}_${VERSION}_${OS}_${ARCH}.${EXT}"
  URL="https://github.com/${REPO}/releases/download/v${VERSION}/${FILENAME}"

  printf "  Version:  \033[1mv%s\033[0m\n" "$VERSION"
  printf "  Platform: \033[1m%s/%s\033[0m\n" "$OS" "$ARCH"
  printf "  Install:  \033[1m%s\033[0m\n\n" "$INSTALL_DIR"

  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT

  printf "  Downloading..."
  if ! curl -fsSL "$URL" -o "${TMP_DIR}/${FILENAME}"; then
    printf " \033[31mfailed\033[0m\n"
    printf "\n\033[31mError: download failed. Check that v%s exists at:\033[0m\n" "$VERSION"
    printf "  https://github.com/%s/releases\n" "$REPO"
    exit 1
  fi
  printf " \033[32mdone\033[0m\n"

  printf "  Extracting..."
  if [ "$EXT" = "zip" ]; then
    unzip -qo "${TMP_DIR}/${FILENAME}" -d "$TMP_DIR"
  else
    tar -xzf "${TMP_DIR}/${FILENAME}" -C "$TMP_DIR"
  fi
  printf " \033[32mdone\033[0m\n"

  printf "  Installing..."
  if [ -w "$INSTALL_DIR" ]; then
    mv "${TMP_DIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  else
    sudo mv "${TMP_DIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  fi
  chmod +x "${INSTALL_DIR}/${BINARY}"
  printf " \033[32mdone\033[0m\n"

  printf "\n\033[1;32m✓ hogsend v%s installed to %s\033[0m\n\n" "$VERSION" "$INSTALL_DIR"
  printf "  Run \033[1mhogsend --help\033[0m to get started.\n"
}

main
