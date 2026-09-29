# claude-laya

Routes each Claude Code turn to the cheapest model that can handle it: Haiku, Sonnet or Opus.
The decision is made **locally** by [Laya](https://github.com/NandhaKishorM/laya) in about 40 ms,
so prompts are never sent to a third-party routing service. It is plain Node with no npm
dependencies.

```text
you -> claude -> local proxy -> api.anthropic.com
                     |
                     +-> laya-serve (localhost): haiku | sonnet | opus
```

## Install

Requirements: macOS or Linux, Node 22+, [uv](https://docs.astral.sh/uv/), and Claude Code
logged in (`claude` on your PATH).

```bash
# 1. Laya scorer (about 760 MB Python env; models download on first start)
uv tool install --python 3.12 "laya[serve]"

# 2. This repo
git clone https://github.com/marcellbaan/claude-laya.git
cd claude-laya
npm link          # puts `laya-claude` on your PATH
```

On macOS, `brew install node uv` covers both requirements.

## Run

```bash
laya-claude                       # use it exactly like `claude`
laya-claude --resume              # all arguments are passed through
laya-claude -p "run the tests"
```

The first run starts `laya-serve` in the background and downloads about 1.4 GB of models from
Hugging Face. Later sessions reuse the running server and start instantly.

While running:

- **Routing is on by default.** The session starts on **Laya Router** in `/model`. Picking
  another model there turns routing off for that session.
- **Force a tier** for one turn by *starting* the prompt with `use haiku`, `use sonnet` or `use opus`
  (`switch to …` also works). A mention later in the prompt is ignored. Upgrades always apply.
  A forced downgrade is refused on a large conversation, to keep the prompt cache. To force one
  anyway, pick the model in `/model`.
- **The status line** shows the last decision, such as `⚡ haiku d=0.14 · my-repo`. It's added
  only if you don't already have a status line configured.

To check it works, run `LAYA_DEBUG=1 laya-claude -p "what is 2+2?"`. Then read
`~/.laya-claude/debug.log`, which should show `"tier":"haiku"`.

## Stop / uninstall

```bash
pkill -f laya-serve                  # stop the background scorer
npm unlink -g claude-laya            # remove the command
uv tool uninstall laya               # remove Laya
rm -rf ~/.laya-claude                # remove logs and state
# the downloaded models are in ~/.cache/huggingface/hub/models--convaiinnovations--*
```

## How it decides

For each new user turn, Laya answers three questions in one pass: which tier fits, how complex
the task is, and how much reasoning it needs. The average gives a difficulty from 0 to 1:
below 0.375 goes to Haiku, below 0.5 to Sonnet, and anything higher to Opus.

Rules on top of that:

- **Tool steps inside a turn keep the turn's model.**
- **Sub-agents are routed separately.**
- **Large conversations (~20k+ tokens) never downgrade**, because switching models rebuilds the
  prompt cache.
- **If Laya is unavailable, the current model stays** (Opus for a new conversation).

On 18 held-out, hand-labelled coding prompts:

| Right tier | One tier too expensive | One tier too cheap | Two tiers too cheap |
|---|---|---|---|
| 12 | 4 | 2 | 0 |

Expect about 2 in 3 turns on the right tier, with most misses erring toward the more capable
model. To tune it for your work, add prompts to `eval/cases.mjs`, run `npm run eval` (needs
`laya-serve` running), and adjust `LAYA_SONNET_AT` / `LAYA_OPUS_AT`.

## Privacy

- **Headers**, including your Claude credentials, go only to `api.anthropic.com` (or to your
  `ANTHROPIC_BASE_URL`). They are never logged.
- **Prompt text goes only to the local `laya-serve`** and is never written to disk. The status
  file and debug log record just the tier, reason, difficulty and timing, in
  `~/.laya-claude` (mode 700).
- **`laya-serve` gets a minimal environment** (`PATH`, `HOME`, `TMPDIR`, locale, `HF_HOME`,
  `LAYA_*`), not your whole shell environment.
- **Your default model is protected.** If you pick "Laya Router" as your default in `/model`,
  it is reset on exit so plain `claude` keeps working.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `LAYA_SONNET_AT` / `LAYA_OPUS_AT` | `0.375` / `0.5` | difficulty cut points |
| `LAYA_HAIKU_MODEL` | `claude-haiku-4-5-20251001` | model used for the Haiku tier |
| `LAYA_SONNET_MODEL` | `claude-sonnet-5-5` | model used for the Sonnet tier |
| `LAYA_OPUS_MODEL` | `claude-opus-5-5` | model used for the Opus tier |
| `LAYA_DOWNGRADE_MAX_TOKENS` | `20000` | no downgrades above this conversation size |
| `LAYA_URL` | `http://127.0.0.1:8765` | Laya server (only a local URL is auto-started) |
| `LAYA_TIMEOUT_MS` | `2000` | per-turn scoring timeout |
| `LAYA_DEBUG` | off | log decisions (no prompt text) to `~/.laya-claude/debug.log` |
| `LAYA_NO_STATUSLINE` | off | don't add the status line |
| `LAYA_DEVICE`, `LAYA_THREADS` | auto | passed to `laya-serve` (e.g. `cpu`, `cuda`, `mps`) |

## Development

```bash
npm test         # proxy and scorer tests against fake servers; no network or account needed
npm run eval     # routing accuracy against a running laya-serve
```

Code layout:

- `src/proxy.mjs`: the proxy
- `src/score.mjs`: Laya questions and cut points
- `bin/laya-claude.mjs`: the launcher
- `bin/statusline.mjs`: the status line

Tested on macOS with Claude Code 2.1.284 and Node 26. Claude Code's request format is not a
public contract, so a future version may need small proxy changes.

## Licence

Apache License 2.0, the same licence as Laya. See [LICENSE](LICENSE).
