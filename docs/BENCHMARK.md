# Pragma vs Claude Code alone

**Short version:** on a small task, same quality and no measurable extra cost. This is a small experiment that shows a tendency, not a rigorous benchmark.

Pragma does **not** save tokens. Its protocol adds a little structure, and that structure did not cost anything we could measure.

## Method

- **Task:** a small Node.js program built from a written specification, in an empty repository.
- **Quality:** 19 hidden acceptance tests, which neither side saw.
- **Rounds:** three, alternating which side ran first, because the model does not take the same path twice.
- **Model:** `claude-sonnet-5` on both sides, set explicitly.
- **Both sides unattended:** `claude -p` for the CLI, Pragma with auto-confirm on. REVIEW did not exist in the measured version's default setup and was not part of the measure.
- **Cost:** as reported by the CLI itself.
- **Rule set before starting:** quality comes first, and a cost difference within ±15% is noise.

Measured in September 2026, on the version preceding 2.0.0.

## Results

| Round | Order | Tests CLI / Pragma | Cost CLI | Cost Pragma | Difference |
|---|---|---|---|---:|---:|
| 1 | CLI first | 19/19 · 19/19 | $0.84 | $0.70 | -17% |
| 2 | Pragma first | 19/19 · 19/19 | $0.53 | $0.91 | +73% |
| 3 | CLI first | 19/19 · 19/19 | $0.66 | $0.66 | +1% |
| **Total** | | | **$2.02** | **$2.27** | **+13%** |

The differences point in different directions, and the total stays within the noise threshold, so neither side wins on cost.

| Round | Tool calls (`n`) CLI / Pragma | `cacheR/n` CLI / Pragma |
|---|---:|---:|
| 1 | 23 / 16 | 63.6k / 57.8k |
| 2 | 11 / 27 | 52.5k / 63.2k |
| 3 | 13 / 14 | 55.9k / 56.4k |

`cacheR/n` is the average context re-read per tool call. The three figures should be read together: cost alone hides why a run was expensive.

## What it means

Cost depends on the path the model takes, and that path changes from one run to the next more than the protocol changes it: the CLI ranged from 11 to 23 tool calls, Pragma from 14 to 27.

The fixed cost of the protocol is small: about 250 extra tokens on the first call (under 1%), one extra message to continue after the plan, and 2 to 5 tool calls before the plan.

Round 2 is the one to watch. Pragma made 19 edits against 5, writing the file piece by piece. One round cannot say whether that is a habit induced by the protocol or chance.

## Limits

- Three rounds are few.
- A single kind of work: a small new project. This says nothing about a large existing repository, where finding your way around is most of the job.
- In round 1 the CLI started with part of its context still cached from an interrupted launch, a small advantage estimated at a few cents.
- It measures cost and acceptance tests only, not the value of reviewing a plan or of the VERIFY and REVIEW gates.

## Tests in this repository

| Suite | Tests |
|---|---:|
| Frontend (Vitest) | 376 |
| Rust (`cargo test --workspace`) | 148 |
| Component tests (Playwright) | 50 |
| End-to-end on the real app (WebdriverIO) | 29 |
