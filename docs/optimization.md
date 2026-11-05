# Poki Optimized

This is a compatible AGPL-3.0-only fork of Joseph Zhou's Poki, based on
`8e740128a272709504fd57fd638de4df1a048976`. Copyright and third-party notices
remain with their respective authors. Original source: https://github.com/JosssphZhou/poki.

## Run on a Mac

Follow the original installation guide and root AGENTS.md for pairing, signing,
permissions, model login, and optional unlock. macOS 15+, full Xcode, Node 24+,
Python 3, Rust and FFmpeg are still required for a source build.

```sh
./bin/setup
npm ci --prefix agent
export POKI_MCP_STATE_DIR="$PWD/.runtime/optimized-mcp"
export POKI_MCP_EXECUTION_MODE=optimized
npm start -- --port 0
```

Start the client in another terminal with the **same state directory**:

```sh
export POKI_MCP_STATE_DIR="$PWD/.runtime/optimized-mcp"
node src/stdio.mjs
# Or use the original MCP registration instructions with this checkout's path.
```

Execution mode is daemon configuration, not an individual tool option. It defaults
to `legacy`. Roll back by stopping the daemon, setting
`POKI_MCP_EXECUTION_MODE=legacy`, and restarting with the same isolated directory.
Never run two daemons against one endpoint/state directory. Existing tool names,
arguments, text results, default discovery and environment variables are retained.
Status adds `execution_mode`; action/batch responses can add `structuredContent`.

## What changed

- A session owns at most one persistent native worker per device. Workers retain
  the CoreDevice transport and input media gate across operations, exit after
  30 seconds idle, and close before lease/session handover. AX subscriptions are
  still renewed using upstream's timeout behavior. The original native execution
  implementation is retained separately for rollback and comparison.
- Worker ownership is shared across MCP clients: switching clients retires the
  previous device worker and invalidates its element references before dispatch.
  Worker responses are validated, oversized requests are rejected before sending,
  and shutdown releases buffered data without signaling an already exited child.
- Input still receives a 1000 ms media warm-up on session creation and a 300 ms
  post-touch hold. Keyboard/contact cleanup precedes transport teardown. Recording
  start/recovery releases worker media ownership. Dispatched actions are never
  automatically replayed after disconnect, cancellation or response loss.
- Successful actions/batches can carry a complete structured observation built
  from the stabilized AX read and a lossless capture. Non-atomic timestamps,
  revision and worker generation are explicit. Agents validate freshness, device,
  completeness and refs before reusing a receipt; absent/invalid receipts trigger
  the original observation path. Legacy text/image fields remain available.
- Physical screenshots use the pinned idevice DVT screenshot API in memory,
  falling back to the original read-only capture on transport failure. Swift OCR
  accepts either an image path or `-` for stdin. An exact encoded-byte hash bypasses
  decoding and resizing for identical captures; exact pixel hashing also shares
  results across different lossless encodings. PNG, OCR and one JPEG variant share
  a two-entry, 64 MiB cache. In-memory captures avoid temporary-directory work.
  Each capture still has a new observation identity. No perceptual hash authorizes refs.
- Learned routes are checked before model runtime initialization. Version-5
  route files are unchanged; a bounded metadata-validated parse cache helps
  long-running channel workers. Independent exploratory result verification and
  current-value readout remain in place.

## Verify software

```sh
npm ci
npm ci --prefix agent
npm test
npm test --prefix agent
# First fetch the pinned idevice dependency as bin/setup does; no device needed:
cargo test --locked --manifest-path native/bridge/Cargo.toml
```

Protocol tests replace every device program and use private temporary directories.
The optimized integration test goes through the real stdio/HTTP MCP transport,
but its device worker is synthetic. Rust tests compile the bridge on Linux; they
do not prove Apple transport, Swift OCR or physical touch behavior. No real
messages are sent by the test suites. Test-only plist/archive shims remove the
need to install Apple CLI tools for protocol tests.

## Local image-processing measurement

```sh
node bin/benchmark-images.mjs
```

The synthetic benchmark compares the previous warm pixel-cache path with the new
encoded-byte/JPEG cache for repeated identical 1170-by-2532 screenshots at scale 3.
It alternates the paths for 40 measured repetitions after warm-up. On this Linux
x64 / Node 24.22.1 environment, median processing time decreased from **28.67 ms to
1.21 ms** (23.6x); p95 decreased from **34.05 ms to 1.73 ms**. Raw samples and
environment metadata are in [image-benchmark.json](image-benchmark.json).

This measures repeated-image processing only, excluding device capture, AX, OCR
execution and model time. It compares against the earlier fork implementation,
not an end-to-end upstream run. Changing images still require decoding and
resizing. These numbers do not establish physical-device task speedup.

## Physical performance acceptance

Hardware results are **pending**. No 30% or 2x improvement is claimed yet.

1. On your Mac, prepare and authorize the phone following the original guide.
   Build and sign the existing `PokiMCPFixture` Xcode project with your development
   team, and install bundle `local.pokimcp.fixture` on that phone. Its controls are
   disposable. Do not use personal messaging, payment or account apps for tests.
2. Make a clean checkout of the pinned original commit and run its setup. Build
   this fork as well. Stop other automation using the phone. Keep your current
   locale; record connection type and OS versions, and manually record locale and
   network/load conditions alongside the generated device metadata.
3. Run the following from this fork, using a new private output directory:

```sh
node bin/benchmark-physical.mjs \
  --baseline /absolute/path/to/original-poki \
  --device YOUR_DEVICE_UUID \
  --out "$PWD/.runtime/physical-benchmark-1" \
  --confirm-fixture --repeats 30 --stress 300
```

The script uses isolated daemon state, alternates baseline/candidate order,
resets the fixture outside timing, verifies each result, and stops immediately on
failure. It records per-call nested timing phases, JSONL trials and p50/p95
summaries. Cold means the first worker pass; warm means subsequent passes, **not**
cold app launch (app reset is outside timing). Stress runs count verified taps.
Raw results and device metadata are private and must not be committed.

This runner covers read, tap, ASCII/Chinese/emoji fill, batch, scroll and recording.
Fill intentionally does not submit. Before enabling optimized mode by default,
also run the existing agent acceptance flow with the same model/tier on both
versions: learn a route, repeat it with changed field values, change the UI to
force recovery, and verify submission only in the disposable fixture. Perform
separately supervised disconnect/cancel, wrong-target, and channel-delivery tests.
The runner does not automate disconnecting your phone, model/provider comparisons,
or real iMessage/Telegram delivery. Those acceptance checks remain manual.

Release gates: at least 30% lower suite median verified completion time; no worse
p95 or observed success rate; zero wrong-target actions, duplicate submissions or
false success in the acceptance sample. 2x faster repeated tasks is a stretch goal.
Collect CPU/RSS on the Mac with Activity Monitor or Instruments during identical
runs; retain the reports with the benchmark output. Sample results are not a
universal reliability guarantee. If a gate fails, keep optimized mode opt-in.

## Package on Apple Silicon

```sh
./bin/package-macos
```

This builds and emits `build/releases/poki-optimized-v0.1.0-macos-arm64.tar.gz`
and a SHA-256 checksum. It includes source, licenses, native bridge, OCR,
simulator helper, unlock helper and pinned idevice executables. It excludes
credentials, pairing records, npm caches and task data. After extracting, run
`npm ci` and `npm ci --prefix agent`; keep the original Xcode/FFmpeg prerequisites.
The packaging script is supplied; no macOS binary package has been built here.
