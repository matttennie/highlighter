/**
 * Source-contract tests for the Chrome native-messaging lifecycle host
 * (server/native_host.py) and its installer (server/install.sh). As with
 * test-server.js we don't spin up Python here — we read the source and check
 * it declares the specified lifecycle-leash behavior. The host itself was
 * end-to-end smoke-tested over pipes (spawn + reap, owned/external, ping/pong)
 * while building this; those checks live in the branch's build report.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');
const host = fs.readFileSync(path.join(rootDir, 'server', 'native_host.py'), 'utf8');
const install = fs.readFileSync(path.join(rootDir, 'server', 'install.sh'), 'utf8');

describe('server/native_host.py', () => {
  it('is Python 3 stdlib only — no kokoro/onnx or third-party web imports', () => {
    assert.doesNotMatch(host, /import\s+kokoro/i);
    assert.doesNotMatch(host, /import\s+onnxruntime/);
    assert.doesNotMatch(host, /flask|fastapi|requests\b|aiohttp/i);
    // stdlib pieces the leash needs
    assert.match(host, /import\s+struct/);
    assert.match(host, /import\s+socket/);
    assert.match(host, /import\s+subprocess/);
    assert.match(host, /import\s+urllib\.request/);
  });

  it('frames messages as 4-byte little-endian uint32 length + UTF-8 JSON', () => {
    assert.match(host, /struct\.Struct\(["']<I["']\)/);
    // read: length prefix then body, short read = EOF
    assert.match(host, /LEN_STRUCT\.size/);
    assert.match(host, /LEN_STRUCT\.unpack\(/);
    assert.match(host, /LEN_STRUCT\.pack\(len\(data\)\)/);
    assert.match(host, /\.decode\(["']utf-8["']\)/);
    assert.match(host, /\.encode\(["']utf-8["']\)/);
  });

  it('treats a short/zero read on stdin as EOF (Chrome gone)', () => {
    assert.match(host, /if\s+len\(raw_len\)\s*<\s*LEN_STRUCT\.size/);
    assert.match(host, /return None/);
    assert.match(host, /if\s+msg_len\s*==\s*0/);
    assert.match(host, /if\s+len\(data\)\s*<\s*msg_len/);
  });

  it('reads the HTTP port from KOKORO_HTTP_PORT, defaulting to 8880', () => {
    assert.match(host, /PORT\s*=\s*int\(os\.environ\.get\(["']KOKORO_HTTP_PORT["'],\s*["']8880["']\)\)/);
    assert.match(host, /HOST\s*=\s*["']127\.0\.0\.1["']/);
  });

  it('checks whether the port is already listening via a socket connect test', () => {
    assert.match(host, /def port_is_listening\(port\)/);
    assert.match(host, /socket\.socket\(socket\.AF_INET,\s*socket\.SOCK_STREAM\)/);
    assert.match(host, /\.connect\(\(HOST,\s*port\)\)/);
  });

  it('owned=False when the port is TAKEN: never spawns, never reaps an external server', () => {
    // If the port is listening, return owned=False with no child.
    const startBlock = host.slice(host.indexOf('def start_server'), host.indexOf('def reap'));
    assert.match(startBlock, /if\s+port_is_listening\(port\):/);
    assert.match(startBlock, /return False,\s*None,\s*True/);
    // reap only runs when owned is true (now also guarded by the shutdown flag)
    assert.match(host, /if\s+owned\s+and\s+child\s+is\s+not\s+None[^\n:]*:\s*[\r\n]+\s*reap\(child\)/);
  });

  it('owned=True path spawns kokoro_server.py with the same interpreter, stderr to the err log', () => {
    assert.match(host, /ERR_LOG\s*=\s*["']\/tmp\/highlighter-kokoro\.err["']/);
    assert.match(host, /kokoro_server\.py/);
    assert.match(host, /subprocess\.Popen\(\s*\[sys\.executable,\s*os\.path\.join\(here,\s*"kokoro_server\.py"\)\]/s);
    assert.match(host, /stderr=errlog/);
    assert.match(host, /return True,\s*child,\s*ok/);
  });

  it('waits for /health (up to 20s) before reporting startup success', () => {
    assert.match(host, /HEALTH_TIMEOUT_S\s*=\s*20/);
    assert.match(host, /def wait_for_health\(port,\s*timeout=HEALTH_TIMEOUT_S\)/);
    assert.match(host, /\/health/);
    assert.match(host, /urllib\.request\.urlopen\(/);
  });

  it('sends exactly one server-status message with ok/owned/port after startup', () => {
    assert.match(host, /send_message\(\{"type":\s*"server-status",\s*"ok":\s*ok,\s*"owned":\s*owned,\s*"port":\s*PORT\}\)/);
  });

  it('answers ping with pong and ignores unknown message types', () => {
    assert.match(host, /msg\.get\(["']type["']\)\s*==\s*["']ping["']/);
    assert.match(host, /send_message\(\{"type":\s*"pong"\}\)/);
    // no branch that replies to anything else
    assert.match(host, /ignore every other message type/);
  });

  it('reaps the child on EOF/SIGTERM with SIGTERM -> 5s grace -> SIGKILL', () => {
    assert.match(host, /REAP_GRACE_S\s*=\s*5/);
    assert.match(host, /def reap\(child\)/);
    assert.match(host, /child\.terminate\(\)/);              // SIGTERM
    assert.match(host, /child\.wait\(timeout=REAP_GRACE_S\)/);
    assert.match(host, /child\.kill\(\)/);                   // SIGKILL
    // SIGTERM is turned into an unwind so the finally-block reaps
    assert.match(host, /signal\.signal\(signal\.SIGTERM,\s*_on_sigterm\)/);
    assert.match(host, /raise SystemExit/);
    // cleanup lives in a finally so no exception path orphans the child
    assert.match(host, /finally:/);
  });

  it('starts the shared server outside Chrome via launchd and tracks its warmth claim', () => {
    assert.match(host, /SHARED_TTS_DIR/);
    assert.match(host, /launchctl", "submit"/);
    assert.match(host, /write_marker\(\)/);
    assert.match(host, /remove_marker\(\)/);
    assert.match(host, /def _watch_port\(\)/);
  });

  it('watches the owned child and exits the host when it exits (idle self-exit → port drops)', () => {
    assert.match(host, /import\s+threading/);
    assert.match(host, /def _watch_child\(child\)/);
    assert.match(host, /child\.wait\(\)/);                   // block until the server exits, however it exits
    assert.match(host, /os\._exit\(0\)/);                    // hard-exit the whole host from the watch thread
    // The watch thread is started only for a child we own.
    const startBlock = host.slice(host.indexOf('def main'), host.length);
    assert.match(startBlock, /if\s+owned\s+and\s+child\s+is\s+not\s+None:/);
    assert.match(startBlock, /threading\.Thread\(target=_watch_child,\s*args=\(child,\),\s*daemon=True\)\.start\(\)/);
  });

  it('guards the single shutdown path so reap and child-watch never race/double-reap', () => {
    assert.match(host, /_shutdown_lock\s*=\s*threading\.Lock\(\)/);
    assert.match(host, /_shutting_down\s*=\s*False/);
    // Both the watch thread and the finally-block claim the flag under the lock.
    assert.match(host, /with _shutdown_lock:/);
    // The finally reap is skipped once shutdown is already claimed.
    assert.match(host, /if\s+owned\s+and\s+child\s+is\s+not\s+None\s+and\s+not\s+already:/);
  });
});

describe('server/install.sh', () => {
  it('registers the host manifest in BOTH Chrome and Chromium NativeMessagingHosts dirs', () => {
    assert.match(install, /Google\/Chrome\/NativeMessagingHosts/);
    assert.match(install, /Chromium\/NativeMessagingHosts/);
    assert.match(install, /HOST_NAME="com\.highlighter\.kokoro"/);
    assert.match(install, /"\$DIR\/\$\{HOST_NAME\}\.json"/);
  });

  it('retires the old launchd agent and never loads a new one', () => {
    assert.match(install, /launchctl unload/);
    assert.match(install, /rm -f "\$OLD_PLIST_PATH"/);
    assert.doesNotMatch(install, /launchctl load/);   // Chrome owns lifecycle now
  });

  it('writes an executable launcher wrapper and points the manifest path at it (no args field)', () => {
    assert.match(install, /native_host_launcher\.sh/);
    assert.match(install, /exec "\$PYTHON_BIN" "\$NATIVE_HOST_PY"/);
    assert.match(install, /chmod \+x "\$LAUNCHER"/);
    assert.match(install, /"path":\s*"\$\{LAUNCHER\}"/);
    // Chrome manifests have no "args" field — must not emit one.
    assert.doesNotMatch(install, /"args":/);
  });

  it('writes a stdio manifest gated to the extension origin', () => {
    assert.match(install, /"type":\s*"stdio"/);
    assert.match(install, /"allowed_origins":\s*\["chrome-extension:\/\/\$\{EXTENSION_ID\}\/"\]/);
    assert.match(install, /"name":\s*"\$\{HOST_NAME\}"/);
  });

  it('takes the extension id as $1, else installs a placeholder and exits 2', () => {
    assert.match(install, /EXTENSION_ID="\$\{1:-\}"/);
    assert.match(install, /chrome:\/\/extensions/);
    assert.match(install, /exit 2/);
  });

  it('starts no server itself — Chrome starts it on demand', () => {
    // No health-check curl loop, no launchctl load: the installer is inert.
    assert.doesNotMatch(install, /curl .*\/health/);
    assert.match(install, /Chrome will start the Kokoro server on demand/);
  });

  it('keeps the kokoro-onnx + model-files checks intact', () => {
    assert.match(install, /pip" install --quiet --upgrade kokoro-onnx/);
    assert.match(install, /Model files not found/);
  });

  it('installs the runtime host into Application Support, outside TCC-protected dirs', () => {
    // ~/Desktop is TCC-protected: Chrome (a GUI app) is silently blocked from
    // exec'ing anything under it, so the host must live outside the checkout.
    assert.match(install, /INSTALL_DIR="\$HOME\/Library\/Application Support\/HighlighterTTS"/);
    // Runtime files are COPIED out of the checkout into the install dir.
    assert.match(install, /cp\b[^\n]*native_host\.py[^\n]*kokoro_server\.py[^\n]*"\$INSTALL_DIR/);
    // The venv lives in the install dir, not the repo.
    assert.match(install, /python3 -m venv "\$INSTALL_DIR\/\.venv"/);
    assert.match(install, /"\$INSTALL_DIR\/\.venv\/bin\/pip" install --quiet --upgrade kokoro-onnx/);
    // The launcher and the paths it execs all point INTO the install dir.
    assert.match(install, /LAUNCHER="\$INSTALL_DIR\/native_host_launcher\.sh"/);
    assert.match(install, /PYTHON_BIN="\$INSTALL_DIR\/\.venv\/bin\/python3"/);
    assert.match(install, /NATIVE_HOST_PY="\$INSTALL_DIR\/native_host\.py"/);
    // Strip quarantine/provenance xattrs so the GUI app will exec the files.
    assert.match(install, /xattr -c "\$INSTALL_DIR"\/\*/);
  });

  it('ad-hoc signs bundled native libraries so macOS does not flag them', () => {
    // Unsigned .dylib/.so from pip wheels trigger a Gatekeeper warning once a
    // GUI app (Chrome) loads them; an ad-hoc signature quiets it.
    assert.match(install, /-name "\*\.dylib" -o -name "\*\.so"/);
    assert.match(install, /codesign --force --sign - /);
  });
});
